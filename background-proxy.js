// Make sure your API endpoint is correctly implemented
app.post('/api/generate', async (req, res) => {
  try {
    const { profile, type, user } = req.body;
    
    if (!profile || !type) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters' 
      });
    }
    
    // Rest of your implementation...

    // IMPORTANT: Make sure your response is proper JSON
    res.json({ 
      success: true, 
      content: data.choices?.[0]?.message?.content || '' 
    });
  } catch (error) {
    console.error('Content generation error:', error);
    // Always return JSON, never HTML
    res.status(500).json({ 
      success: false, 
      error: 'Server error'
    });
  }
});
