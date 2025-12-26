/**
 * Portal Leads Routes UPDATE for Brynsa Backend
 * File: src/portal-leads.js
 * 
 * This file REPLACES the portal leads routes in src/auth.js
 * OR can be added as additional routes
 * 
 * Adds: lists support for saving leads to lists
 */

const { ObjectId } = require('mongodb');

function setupPortalLeadsRoutes(app, db) {
  const leadsCollection = db.collection('leads');
  const listsCollection = db.collection('portal_lists');
  const usersCollection = db.collection('portal_users');

  // Import auth middleware from auth.js
  const { authMiddleware, optionalAuthMiddleware } = require('./auth');
  const auth = authMiddleware(usersCollection);
  const optionalAuth = optionalAuthMiddleware(usersCollection);

  console.log('👥 Setting up Portal Leads routes (with lists support)...');

  // ==================== SAVE LEAD WITH LISTS ====================
  // POST /api/portal/leads/save - New endpoint for extension with lists support
  app.post('/api/portal/leads/save', optionalAuth, async (req, res) => {
    try {
      const { 
        name, title, company, location, linkedinUrl, 
        email, leadSource, lists 
      } = req.body;

      if (!name) {
        return res.status(400).json({ success: false, error: 'Name is required' });
      }

      // Get userId from auth (or null for anonymous)
      const userId = req.user?._id?.toString() || null;
      const userEmail = req.user?.email || null;

      if (!userId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      // Check for duplicate by LinkedIn URL
      if (linkedinUrl) {
        const existingLead = await leadsCollection.findOne({ 
          linkedinUrl,
          visitorId: userId
        });
        
        if (existingLead) {
          // If lead exists and we're adding to lists, update the lists
          if (lists && lists.length > 0) {
            await leadsCollection.updateOne(
              { _id: existingLead._id },
              { 
                $addToSet: { lists: { $each: lists } },
                $set: { updatedAt: new Date() }
              }
            );
            
            // Auto-create lists if they don't exist
            for (const listName of lists) {
              await listsCollection.updateOne(
                { userId, name: listName },
                { 
                  $setOnInsert: { userId, name: listName, createdAt: new Date() },
                  $set: { updatedAt: new Date() }
                },
                { upsert: true }
              );
            }
            
            console.log(`✅ Lead updated with lists: ${lists.join(', ')}`);
            return res.json({ 
              success: true, 
              duplicate: true, 
              updated: true,
              message: 'Lead updated with new lists',
              leadId: existingLead._id
            });
          }
          return res.json({ 
            success: true, 
            duplicate: true, 
            lead: existingLead 
          });
        }
      }

      // Create new lead
      const newLead = {
        visitorId: userId,
        visitorEmail: userEmail,
        name: sanitizeString(name, 200),
        title: sanitizeString(title, 300) || null,
        company: sanitizeString(company, 200) || null,
        location: sanitizeString(location, 200) || null,
        linkedinUrl: sanitizeString(linkedinUrl, 500) || null,
        email: sanitizeString(email, 200) || null,
        leadSource: leadSource || 'extension',
        lists: lists || [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await leadsCollection.insertOne(newLead);

      // Auto-create lists if they don't exist
      if (lists && lists.length > 0) {
        for (const listName of lists) {
          await listsCollection.updateOne(
            { userId, name: listName },
            { 
              $setOnInsert: { userId, name: listName, createdAt: new Date() },
              $set: { updatedAt: new Date() }
            },
            { upsert: true }
          );
        }
      }

      // Track usage
      await usersCollection.updateOne(
        { _id: req.user._id },
        { $inc: { 'usage.leadsScraped': 1 } }
      );

      console.log(`✅ Lead saved: ${name} to lists: ${lists?.join(', ') || 'none'}`);

      res.json({ 
        success: true, 
        lead: { ...newLead, _id: result.insertedId } 
      });
    } catch (error) {
      console.error('❌ Save lead error:', error);
      res.status(500).json({ success: false, error: 'Failed to save lead' });
    }
  });

  // ==================== UPDATE LEAD LISTS ====================
  // PUT /api/portal/leads/:id/lists - Update lists for a lead
  app.put('/api/portal/leads/:id/lists', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      const { id } = req.params;
      const { lists } = req.body;

      if (!Array.isArray(lists)) {
        return res.status(400).json({ success: false, error: 'Lists must be an array' });
      }

      // Update lead's lists
      await leadsCollection.updateOne(
        { _id: new ObjectId(id), visitorId: userId },
        { 
          $set: { lists, updatedAt: new Date() }
        }
      );

      // Auto-create lists if they don't exist
      for (const listName of lists) {
        await listsCollection.updateOne(
          { userId, name: listName },
          { 
            $setOnInsert: { userId, name: listName, createdAt: new Date() },
            $set: { updatedAt: new Date() }
          },
          { upsert: true }
        );
      }

      res.json({ success: true, message: 'Lists updated' });
    } catch (error) {
      console.error('❌ Update lead lists error:', error);
      res.status(500).json({ success: false, error: 'Failed to update lists' });
    }
  });

  // ==================== REMOVE LEAD FROM LIST ====================
  // DELETE /api/portal/leads/:id/lists/:listName
  app.delete('/api/portal/leads/:id/lists/:listName', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      const { id, listName } = req.params;

      await leadsCollection.updateOne(
        { _id: new ObjectId(id), visitorId: userId },
        { 
          $pull: { lists: decodeURIComponent(listName) },
          $set: { updatedAt: new Date() }
        }
      );

      res.json({ success: true, message: 'Removed from list' });
    } catch (error) {
      console.error('❌ Remove from list error:', error);
      res.status(500).json({ success: false, error: 'Failed to remove from list' });
    }
  });

  console.log('✅ Portal Leads routes registered (with lists support)');
}

// Helper function
function sanitizeString(str, maxLength = 500) {
  if (!str) return '';
  return String(str)
    .replace(/<[^>]*>/g, '')
    .replace(/['"\\]/g, '')
    .trim()
    .substring(0, maxLength);
}

module.exports = { setupPortalLeadsRoutes };