// In index.js (backend)
app.post('/api/generate', async (req, res) => {
  const { profile, type } = req.body;
  
  const prompts = {
    email: `Write a professional email to ${profile.name}...`,
    linkedinMessage: `Write a LinkedIn DM to ${profile.name}...`,
    linkedinNote: `Write a connection note to ${profile.name}...`
  };

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompts[type] }],
        temperature: 0.7,
        max_tokens: type === 'linkedinNote' ? 200 : 300
      })
    });

    const data = await response.json();
    res.json({ 
      success: true, 
      content: data.choices?.[0]?.message?.content || '' 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
