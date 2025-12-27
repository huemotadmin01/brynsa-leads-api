/**
 * Portal Leads Routes - With User Isolation & Bulk Delete
 * File: src/portal-leads.js
 * 
 * COPY THIS ENTIRE FILE and paste into src/portal-leads.js
 */

const { ObjectId } = require('mongodb');

function setupPortalLeadsRoutes(app, db) {
  const leadsCollection = db.collection('leads');
  const listsCollection = db.collection('portal_lists');
  const usersCollection = db.collection('portal_users');

  const { authMiddleware, optionalAuthMiddleware } = require('./auth');
  const auth = authMiddleware(usersCollection);
  const optionalAuth = optionalAuthMiddleware(usersCollection);

  console.log('👥 Setting up Portal Leads routes...');

  // ==================== GET ALL LEADS ====================
  app.get('/api/portal/leads', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      const { page = 1, limit = 50, listName, search } = req.query;

      const query = { userId };
      if (listName) query.lists = listName;
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { company: { $regex: search, $options: 'i' } },
          { companyName: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ];
      }

      const total = await leadsCollection.countDocuments(query);
      const leads = await leadsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .toArray();

      res.json({ success: true, leads, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
    } catch (error) {
      console.error('❌ Get leads error:', error);
      res.status(500).json({ success: false, error: 'Failed to get leads' });
    }
  });

  // ==================== SAVE LEAD ====================
  app.post('/api/portal/leads/save', optionalAuth, async (req, res) => {
    try {
      const { name, title, company, location, linkedinUrl, email, leadSource, lists } = req.body;

      if (!name) {
        return res.status(400).json({ success: false, error: 'Name is required' });
      }

      const userId = req.user?._id?.toString() || null;
      const userEmail = req.user?.email || null;

      if (!userId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      // Check duplicate
      if (linkedinUrl) {
        const existing = await leadsCollection.findOne({ linkedinUrl, userId });
        if (existing) {
          if (lists && lists.length > 0) {
            await leadsCollection.updateOne(
              { _id: existing._id },
              { $addToSet: { lists: { $each: lists } }, $set: { updatedAt: new Date() } }
            );
            for (const listName of lists) {
              await listsCollection.updateOne(
                { userId, name: listName },
                { $setOnInsert: { userId, name: listName, createdAt: new Date() }, $set: { updatedAt: new Date() } },
                { upsert: true }
              );
            }
            return res.json({ success: true, duplicate: true, updated: true, leadId: existing._id });
          }
          return res.json({ success: true, duplicate: true, lead: existing });
        }
      }

      const newLead = {
        userId,
        userEmail,
        name: sanitizeString(name, 200),
        title: sanitizeString(title, 300) || null,
        company: sanitizeString(company, 200) || null,
        companyName: sanitizeString(company, 200) || null,
        location: sanitizeString(location, 200) || null,
        linkedinUrl: sanitizeString(linkedinUrl, 500) || null,
        email: sanitizeString(email, 200) || null,
        leadSource: leadSource || 'extension',
        lists: lists || [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await leadsCollection.insertOne(newLead);

      if (lists && lists.length > 0) {
        for (const listName of lists) {
          await listsCollection.updateOne(
            { userId, name: listName },
            { $setOnInsert: { userId, name: listName, createdAt: new Date() }, $set: { updatedAt: new Date() } },
            { upsert: true }
          );
        }
      }

      await usersCollection.updateOne({ _id: req.user._id }, { $inc: { 'usage.leadsScraped': 1 } });

      console.log(`✅ Lead saved: ${name}`);
      res.json({ success: true, lead: { ...newLead, _id: result.insertedId } });
    } catch (error) {
      console.error('❌ Save lead error:', error);
      res.status(500).json({ success: false, error: 'Failed to save lead' });
    }
  });

  // ==================== DELETE SINGLE LEAD ====================
  app.delete('/api/portal/leads/:id', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      const result = await leadsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
        userId
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({ success: false, error: 'Lead not found' });
      }

      console.log(`✅ Lead deleted by ${req.user.email}`);
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Delete lead error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete lead' });
    }
  });

  // ==================== BULK DELETE LEADS ====================
  app.post('/api/portal/leads/bulk-delete', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      const { ids } = req.body;

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, error: 'Lead IDs required' });
      }

      const objectIds = ids.map(id => {
        try { return new ObjectId(id); } catch (e) { return null; }
      }).filter(Boolean);

      const result = await leadsCollection.deleteMany({
        _id: { $in: objectIds },
        userId
      });

      console.log(`✅ Bulk deleted ${result.deletedCount} leads by ${req.user.email}`);
      res.json({ success: true, deletedCount: result.deletedCount });
    } catch (error) {
      console.error('❌ Bulk delete error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete leads' });
    }
  });

  // ==================== UPDATE LEAD LISTS ====================
  app.put('/api/portal/leads/:id/lists', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      const { lists } = req.body;

      if (!Array.isArray(lists)) {
        return res.status(400).json({ success: false, error: 'Lists must be an array' });
      }

      await leadsCollection.updateOne(
        { _id: new ObjectId(req.params.id), userId },
        { $set: { lists, updatedAt: new Date() } }
      );

      for (const listName of lists) {
        await listsCollection.updateOne(
          { userId, name: listName },
          { $setOnInsert: { userId, name: listName, createdAt: new Date() }, $set: { updatedAt: new Date() } },
          { upsert: true }
        );
      }

      res.json({ success: true });
    } catch (error) {
      console.error('❌ Update lists error:', error);
      res.status(500).json({ success: false, error: 'Failed to update lists' });
    }
  });

  // ==================== REMOVE FROM LIST ====================
  app.delete('/api/portal/leads/:id/lists/:listName', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      await leadsCollection.updateOne(
        { _id: new ObjectId(req.params.id), userId },
        { $pull: { lists: decodeURIComponent(req.params.listName) }, $set: { updatedAt: new Date() } }
      );
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Remove from list error:', error);
      res.status(500).json({ success: false, error: 'Failed to remove from list' });
    }
  });

  // Create indexes
  leadsCollection.createIndex({ userId: 1, createdAt: -1 }).catch(() => {});
  leadsCollection.createIndex({ userId: 1, linkedinUrl: 1 }).catch(() => {});
  leadsCollection.createIndex({ userId: 1, lists: 1 }).catch(() => {});

  console.log('✅ Portal Leads routes registered');
}

function sanitizeString(str, maxLength = 500) {
  if (!str) return '';
  return String(str).replace(/<[^>]*>/g, '').replace(/['"\\]/g, '').trim().substring(0, maxLength);
}

module.exports = { setupPortalLeadsRoutes };