// Add this to background-proxy.js
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// This is the endpoint that's missing
app.post('/api/generate', async (req, res) => {
  try {
    const { profile, type, user } = req.body;
    
    if (!profile || !type) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters' 
      });
    }
    
    // Your OpenAI API logic here
    const senderName = user?.name || "Priyanshu";
    let prompt = '';
    
    // Build prompt based on type and profile data
    if (type === 'email') {
      // Your existing email prompt logic
      // ...
    } 
    else if (type === 'linkedinMessage') {
      // Your existing LinkedIn message prompt logic
      // ...
    }
    else if (type === 'linkedinNote') {
      // Your existing LinkedIn note prompt logic
      // ...
    }

    // Call OpenAI API
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

// Make sure you have a root endpoint too for testing
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'API is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
