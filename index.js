import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { openai } from './lib/openai.js';

const app = express();
dotenv.config();
const port = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());

// ========== FORECAST ENDPOINT ==========
app.post('/forecast', async (req, res) => {
  const { currentGlucose } = req.body;

  const prompt = `
You are a medical AI that predicts blood glucose trends.
Given the current glucose reading: ${currentGlucose} mg/dL,
forecast the glucose level after 30 minutes.
Respond with only the number (in mg/dL) expected after 30 minutes.
  `;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 100,
    });

    const forecast = completion.choices[0].message.content.trim();
    res.json({ forecast });
  } catch (error) {
    console.error('Forecast error:', error.message);
    res.status(500).json({ error: 'Forecast failed' });
  }
});

// ========== PREDICTIVE ALERT ENDPOINT ==========
app.post('/predict', async (req, res) => {
  const { glucoseHistory, insulinType, insulinUnits, calories, activity } = req.body;

  const prompt = `
You are a diabetes prediction AI.
Analyze the following data:
- Glucose readings: ${glucoseHistory}
- Insulin type: ${insulinType}
- Insulin units: ${insulinUnits}
- Calories: ${calories}
- Activity: ${activity}

1. Predict the user's blood glucose value 30 minutes from now (in mg/dL).
2. Determine the risk type:
   - "Hypo risk" if below 100 mg/dL
   - "Hyper risk" if above 150 mg/dL
   - "Stable" if between 100 and 150 mg/dL
3. Respond in this exact JSON format only:
{
  "forecast_mgdl": [number],
  "risk_type": "Hypo risk" or "Hyper risk" or "Stable",
  "forecast_minutes": 30
}
  `;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 300,
    });

    const text = completion.choices[0].message.content;
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    const jsonString = text.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(jsonString);

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
        message: 'Risk of Hypoglycemia forecasted. Check your BG and take necessary actions.',
      };
    } else if (parsed.risk_type === 'Hyper risk') {
      mainAlert = {
        type: 'Warning!',
        message: 'Risk of Hyperglycemia forecasted. Monitor closely.',
      };
    } else {
      mainAlert = {
        type: 'Stable',
        message: 'No immediate risk detected.',
      };
    }

    res.json({
      forecast_mgdl: parsed.forecast_mgdl,
      main_alert: mainAlert,
      alerts: alertList,
    });
  } catch (error) {
    console.error('Prediction error:', error.message);
    res.status(500).json({ error: 'Prediction failed' });
  }
});

// ========== SUMMARY ENDPOINT ==========
app.post('/summarize', async (req, res) => {
  try {
    const { values } = req.body;

    if (!values) {
      return res.status(400).json({ message: 'No values provided' });
    }

    const systemPrompt = `
You are a clinical AI assistant analyzing patient data.
Always respond using this exact structure:

Risk Summary:
- Hypoglycemia probability: [percentage]
- Hyperglycemia probability: [percentage]
- Overall forecast: [Stable / Risk of spike / Risk of drop]
Recommendation:
- [Provide one simple and clear health suggestion]
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
  res.send('AI Predictive Alert and Forecast API is running.');
});

// ========== SERVER LISTEN ==========
app.listen(port, () => {
  console.log(`AI server listening at http://localhost:${port}`);
});
