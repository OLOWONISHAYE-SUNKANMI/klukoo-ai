import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { openai } from './lib/openai.js';

const app = express();
dotenv.config();
const port = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

// ========== FORECAST ENDPOINT (unchanged but improved validation) ==========
app.post('/forecast', async (req, res) => {
  const { currentGlucose } = req.body;

  if (!currentGlucose || isNaN(currentGlucose)) {
    return res.status(400).json({ error: 'Invalid glucose value' });
  }

  const prompt = `
You are a clinical diabetes forecasting assistant.
Given a current glucose level of ${currentGlucose} mg/dL, 
estimate the glucose level after 30 minutes considering normal physiological glucose metabolism.
Respond only with the numeric glucose forecast (mg/dL).
  `;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 50,
    });

    const forecastRaw = completion.choices[0].message.content.trim();
    const forecast = parseFloat(forecastRaw);

    // Fallback check
    const safeForecast =
      !isNaN(forecast) && forecast > 40 && forecast < 400
        ? forecast
        : Number(currentGlucose) + Math.floor(Math.random() * 10 - 5);

    res.json({ forecast: safeForecast });
  } catch (error) {
    console.error('Forecast error:', error.message);
    res.status(500).json({ error: 'Forecast failed' });
  }
});

// ========== PREDICTIVE ALERT ENDPOINT (major improvement) ==========
app.post('/predict', async (req, res) => {
  const { glucoseHistory, insulinType, insulinUnits, calories, activity } = req.body;

  // Basic input validation
  if (!glucoseHistory || !Array.isArray(glucoseHistory) || glucoseHistory.length === 0) {
    return res.status(400).json({ error: 'Glucose history is required' });
  }

  const latestGlucose = glucoseHistory[glucoseHistory.length - 1];

  // Precompute expected physiological adjustment
  let adjustment = 0;
  if (insulinType?.toLowerCase().includes('fast')) adjustment -= insulinUnits * 3;
  if (insulinType?.toLowerCase().includes('long')) adjustment -= insulinUnits * 1.5;
  if (calories > 400) adjustment += 15;
  if (activity?.toLowerCase().includes('walk') || activity?.toLowerCase().includes('run'))
    adjustment -= 10;

  const approxForecast = latestGlucose + adjustment;
  const boundedForecast = Math.max(60, Math.min(approxForecast, 250));

  // Improved AI prompt with structured reasoning
  const prompt = `
You are a diabetes management AI.
Use the following patient data to predict the next glucose level (in mg/dL) after 30 minutes 
and determine the risk category.

Data:
- Recent glucose readings: ${glucoseHistory.join(', ')}
- Insulin type: ${insulinType}
- Insulin units: ${insulinUnits}
- Calories consumed: ${calories}
- Activity: ${activity}

Rules:
1. If predicted glucose < 100 → "Hypo risk"
2. If predicted glucose > 150 → "Hyper risk"
3. Otherwise → "Stable"
4. Consider insulin, meal, and activity impacts realistically.

Respond strictly as JSON:
{
  "forecast_mgdl": [number],
  "risk_type": "Hypo risk" | "Hyper risk" | "Stable",
  "forecast_minutes": 30
}
  `;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 150,
    });

    const text = completion.choices[0].message.content;
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    const jsonString = text.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(jsonString);

    // Fallback: if AI output is invalid or unreasonable
    if (isNaN(parsed.forecast_mgdl)) parsed.forecast_mgdl = boundedForecast;
    if (!parsed.risk_type) {
      if (parsed.forecast_mgdl < 100) parsed.risk_type = 'Hypo risk';
      else if (parsed.forecast_mgdl > 150) parsed.risk_type = 'Hyper risk';
      else parsed.risk_type = 'Stable';
    }

    const now = new Date();
    const alertTime = new Date(now.getTime() + parsed.forecast_minutes * 60000);

    const alertList = [
      {
        risk: parsed.risk_type,
        in_minutes: parsed.forecast_minutes,
        time: alertTime.toTimeString().slice(0, 5),
      },
    ];

    let mainAlert = {};
    if (parsed.risk_type === 'Hypo risk') {
      mainAlert = {
        type: 'Predictive Alert!',
        message:
          'Risk of Hypoglycemia forecasted. Check your BG and take necessary actions (consume fast-acting carbs).',
        color: '#e74c3c',
      };
    } else if (parsed.risk_type === 'Hyper risk') {
      mainAlert = {
        type: 'Warning!',
        message:
          'Risk of Hyperglycemia forecasted. Consider monitoring and adjusting insulin if advised.',
        color: '#f1c40f',
      };
    } else {
      mainAlert = {
        type: 'Stable',
        message: 'No immediate risk detected. Continue monitoring as usual.',
        color: '#2ecc71',
      };
    }

    res.json({
      forecast_mgdl: parsed.forecast_mgdl,
      main_alert: mainAlert,
      alerts: alertList,
      baseline: boundedForecast,
    });
  } catch (error) {
    console.error('Prediction error:', error.message);
    res.status(500).json({ error: 'Prediction failed' });
  }
});

// ========== SUMMARY ENDPOINT (slightly optimized) ==========
app.post('/summarize', async (req, res) => {
  try {
    const { values } = req.body;
    if (!values) {
      return res.status(400).json({ message: 'No values provided' });
    }

    const systemPrompt = `
You are a medical AI generating a summary of the patient's glucose risk.
Always respond exactly in this structure:

Risk Summary:
- Hypoglycemia probability: [percentage]
- Hyperglycemia probability: [percentage]
- Overall forecast: [Stable / Risk of spike / Risk of drop]
Recommendation:
- [One short clear action suggestion]
    `;

    const userPrompt = `Health data: ${JSON.stringify(values)}`;

    const chat = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 300,
    });

    const summary = chat.choices[0].message.content.trim();
    res.json({ summary });
  } catch (error) {
    console.error('Summary error:', error.message);
    res.status(500).json({ message: 'Error generating summary' });
  }
});

// ========== ROOT ROUTE ==========
app.get('/', (req, res) => {
  res.send('✅ AI Predictive Alert and Forecast API is running.');
});

// ========== SERVER ==========
app.listen(port, () => {
  console.log(`🚀 AI server listening at http://localhost:${port}`);
});
