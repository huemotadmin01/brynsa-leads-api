/**
 * Lists Routes for Brynsa Backend
 * File: src/lists.js
 * 
 * Add to your server by importing and calling setupListsRoutes(app, db)
 */

const { ObjectId } = require('mongodb');

function setupListsRoutes(app, db) {
  const listsCollection = db.collection('portal_lists'); // NEW collection for lists
  const leadsCollection = db.collection('leads');
  const usersCollection = db.collection('portal_users');

  // Import auth middleware from auth.js
  const { authMiddleware } = require('./auth');
  const auth = authMiddleware(usersCollection);

  console.log('📋 Setting up Lists routes...');

  // ==================== GET ALL LISTS ====================
  // GET /api/lists
  app.get('/api/lists', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      
      // Get all lists for user
      const lists = await listsCollection.find({ userId }).sort({ createdAt: -1 }).toArray();
      
      // Get lead counts for each list (excluding soft-deleted leads)
      const listsWithCounts = await Promise.all(
        lists.map(async (list) => {
          const count = await leadsCollection.countDocuments({
            $or: [{ userId }, { visitorId: userId }],
            lists: list.name,
            deleted: { $ne: true }  // Exclude soft-deleted leads
          });
          return {
            _id: list._id,
            name: list.name,
            count,
            createdAt: list.createdAt
          };
        })
      );

      res.json({ success: true, lists: listsWithCounts });
    } catch (error) {
      console.error('❌ Get lists error:', error);
      res.status(500).json({ success: false, error: 'Failed to get lists' });
    }
  });

  // ==================== CREATE LIST ====================
  // POST /api/lists
  app.post('/api/lists', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      const { name } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'List name is required' });
      }

      const listName = name.trim();

      // Check if list already exists
      const existing = await listsCollection.findOne({ userId, name: listName });
      if (existing) {
        return res.status(400).json({ success: false, error: 'List already exists' });
      }

      const newList = {
        userId,
        name: listName,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await listsCollection.insertOne(newList);
      
      console.log(`✅ List created: ${listName} for user ${userId}`);
      
      res.json({ 
        success: true, 
        list: { 
          _id: result.insertedId, 
          name: newList.name, 
          count: 0,
          createdAt: newList.createdAt
        } 
      });
    } catch (error) {
      console.error('❌ Create list error:', error);
      res.status(500).json({ success: false, error: 'Failed to create list' });
    }
  });

  // ==================== DELETE LIST ====================
  // DELETE /api/lists/:listName
  app.delete('/api/lists/:listName', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      const listName = decodeURIComponent(req.params.listName);

      // Delete the list
      const deleteResult = await listsCollection.deleteOne({ userId, name: listName });

      if (deleteResult.deletedCount === 0) {
        return res.status(404).json({ success: false, error: 'List not found' });
      }

      // Remove list from all leads (keep leads, just remove list association)
      await leadsCollection.updateMany(
        { $or: [{ userId }, { visitorId: userId }], lists: listName },
        { $pull: { lists: listName } }
      );

      console.log(`✅ List deleted: ${listName} for user ${userId}`);

      res.json({ success: true, message: 'List deleted' });
    } catch (error) {
      console.error('❌ Delete list error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete list' });
    }
  });

  // ==================== GET LEADS IN LIST ====================
  // GET /api/lists/:listName/leads
  app.get('/api/lists/:listName/leads', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      const listName = decodeURIComponent(req.params.listName);
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      // Get total count (excluding soft-deleted leads)
      const total = await leadsCollection.countDocuments({
        $or: [{ userId }, { visitorId: userId }],
        lists: listName,
        deleted: { $ne: true }  // Exclude soft-deleted leads
      });

      // Get paginated leads (excluding soft-deleted leads)
      const leads = await leadsCollection
        .find({
          $or: [{ userId }, { visitorId: userId }],
          lists: listName,
          deleted: { $ne: true }  // Exclude soft-deleted leads
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      res.json({
        success: true,
        leads,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      });
    } catch (error) {
      console.error('❌ Get list leads error:', error);
      res.status(500).json({ success: false, error: 'Failed to get leads' });
    }
  });

  // Create indexes
  listsCollection.createIndex({ userId: 1, name: 1 }, { unique: true }).catch(() => {});
  leadsCollection.createIndex({ visitorId: 1, lists: 1 }).catch(() => {});
  leadsCollection.createIndex({ userId: 1, lists: 1 }).catch(() => {});

  console.log('✅ Lists routes registered: /api/lists');
}

module.exports = { setupListsRoutes };