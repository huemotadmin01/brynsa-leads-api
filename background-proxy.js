// background-proxy.js - Complete implementation
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Improved CORS settings with specific origin
app.use(cors({
  origin: [
    'chrome-extension://YOUR_EXTENSION_ID',  // Replace with your actual extension ID
    'https://linkedin.com',
    'https://www.linkedin.com'
  ],
  methods: ['POST'],
  allowedHeaders: ['Content-Type'],
  maxAge: 86400 // 24 hours
}));

app.use(express.json());

// Add basic rate limiting
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later'
});

// Apply rate limiter to all requests
app.use(limiter);

// Centralized error handler
app.use((err, req, res, next) => {
  console.error('API Error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Server error' : err.message
  });
});

// Content generation endpoint
app.post('/api/generate', async (req, res) => {
  try {
    const { profile, type, user } = req.body;
    
    if (!profile || !type) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters' 
      });
    }
    
    // Validate request
    if (!['email', 'linkedinMessage', 'linkedinNote'].includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid content type' 
      });
    }
    
    const senderName = user?.name || "Priyanshu";
    
    // Build prompt based on type and profile data
    let prompt;
    
    if (type === 'email') {
      if (profile?.profileType?.toLowerCase() === "candidate") {
        const first = profile.name?.trim().split(/\s+/)[0] || "there";
        const role = profile.currentTitle || profile.headline || "your role";
        const company = profile.companyName || "your company";

        prompt = `Write a concise recruiting email to ${first} for a contract ${role} role.
Start with "Subject:" then the subject line.
Body: 5-7 sentences, mention 6-12 month contract, remote/flexible with IST overlap, competitive rate.
Reference their work at ${company}.
Ask for a quick 10-15 min call this week.
Sign off as "${senderName} — Senior Recruiter at Huemot Technology"`;
      } else {
        prompt = `Write a professional outreach email to ${profile.name}, a ${profile.headline} at ${profile.companyName}. Introduce Huemot Technology and highlight IT staff augmentation, Salesforce & SAP consulting, AI/ML development, and cloud migration services. Ask for a quick intro call. Sign off as "${senderName} — Senior Client Service Manager at Huemot Technology"`;
      }
    } 
    else if (type === 'linkedinMessage') {
      if (profile?.profileType?.toLowerCase() === "candidate") {
        const first = profile.name?.trim().split(/\s+/)[0] || "there";
        const role = profile.currentTitle || profile.headline || "your role";
        const company = profile.companyName || "your company";

        prompt = `Write a short LinkedIn DM (≤400 chars) to ${first} about a contract ${role} role. Reference work at ${company}. Warm & businesslike. Soft CTA for 10-min chat this week. Sign as "${senderName} — Senior Recruiter at Huemot Technology"`;
      } else {
        prompt = `Write a friendly LinkedIn message (under 500 characters) to ${profile.name}, a ${profile.headline}. Mention you're from Huemot Technology and express interest in connecting to explore IT support opportunities. Sign off as "${senderName} — Senior Client Service Manager at Huemot Technology"`;
      }
    }
    else if (type === 'linkedinNote') {
      const firstName = profile.name?.trim().split(/\s+/)[0] || "there";
      if (profile?.profileType?.toLowerCase() === "candidate") {
        const role = profile.currentTitle || profile.headline || "your role";
        prompt = `You are ${senderName}, Senior Recruiter at Huemot. Write a connection note under 200 chars to ${firstName}. Begin "Hi ${firstName},". Pitch a contract ${role}. End with soft CTA for 10-min chat. Output only the note.`;
      } else {
        prompt = `You are ${senderName} from Huemot Technology. Write a LinkedIn connection note under 200 characters to ${firstName}. Begin with "Hi ${firstName},". Mention IT services and a friendly reason to connect. Output only the note text.`;
      }
    }

    // Call OpenAI API - now safely from the backend
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: type === 'linkedinNote' ? 200 : 300
      })
    });

    const data = await response.json();
    
    // Handle API errors
    if (data.error) {
      console.error('OpenAI API error:', data.error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to generate content'
      });
    }
    
    // Return the generated content
    res.json({ 
      success: true, 
      content: data.choices?.[0]?.message?.content || '' 
    });
  } catch (error) {
    console.error('Content generation error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Server error'
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Secure backend proxy running on port ${PORT}`);
});
