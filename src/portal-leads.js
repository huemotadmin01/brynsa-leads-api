/**
 * Portal Leads Routes - FIXED with Consistent userId, VALIDATION, AND DUPLICATE UPDATES
 * File: src/portal-leads.js
 * 
 * FIXES:
 * 1. Uses userId consistently (not visitorId)
 * 2. Checks duplicates using BOTH userId and visitorId for backward compat
 * 3. Uses consistent field names (companyName, not company)
 * 4. Properly stores all lead data
 * 5. NEW: Updates lead data when duplicate is found (not just lists)
 * 
 * VALIDATION UPDATE:
 * - Name cannot be blank
 * - Name cannot contain digits
 * - CompanyName cannot be blank
 */

const { ObjectId } = require('mongodb');

function setupPortalLeadsRoutes(app, db) {
  const leadsCollection = db.collection('leads');
  const listsCollection = db.collection('portal_lists');
  const usersCollection = db.collection('portal_users');

  const { authMiddleware, optionalAuthMiddleware } = require('./auth');
  const { validateLead, validateName, validateCompanyName } = require('./validation');
  const auth = authMiddleware(usersCollection);
  const optionalAuth = optionalAuthMiddleware(usersCollection);

  console.log('👥 Setting up Portal Leads routes (FIXED + VALIDATED + DUPLICATE UPDATES)...');

  // ==================== GET ALL LEADS ====================
  app.get('/api/portal/leads', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      const { page = 1, limit = 50, listName, search } = req.query;

      // Query using BOTH userId and visitorId for backward compatibility
      const query = {
        $or: [
          { userId: userId },
          { visitorId: userId }
        ]
      };
      
      if (listName) query.lists = listName;
      if (search) {
        const searchQuery = {
          $or: [
            { name: { $regex: search, $options: 'i' } },
            { company: { $regex: search, $options: 'i' } },
            { companyName: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } }
          ]
        };
        // Combine with userId query
        query.$and = [
          { $or: [{ userId: userId }, { visitorId: userId }] },
          searchQuery
        ];
        delete query.$or;
      }

      const total = await leadsCollection.countDocuments(query);
      const leads = await leadsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .toArray();

      res.json({ 
        success: true, 
        leads, 
        total, 
        page: parseInt(page), 
        totalPages: Math.ceil(total / parseInt(limit)) 
      });
    } catch (error) {
      console.error('❌ Get leads error:', error);
      res.status(500).json({ success: false, error: 'Failed to get leads' });
    }
  });

  // ==================== SAVE LEAD (WITH VALIDATION AND DUPLICATE UPDATES) ====================
  app.post('/api/portal/leads/save', optionalAuth, async (req, res) => {
    try {
      const { 
        name, 
        title, 
        headline,
        company, 
        companyName,
        location, 
        linkedinUrl, 
        email, 
        phone,
        profilePicture,
        about,
        currentTitle,
        sourcedBy,
        leadSource, 
        lists,
        // Email metadata (for smart update logic)
        emailSource,
        emailConfidence,
        emailPattern
      } = req.body;

      // ================================================================
      // VALIDATION: Name and CompanyName required, Name cannot have digits
      // ================================================================
      const finalCompanyName = companyName || company;
      
      // Validate name
      const nameValidation = validateName(name);
      if (!nameValidation.valid) {
        console.log(`❌ Portal lead validation failed (name): ${nameValidation.error}`);
        return res.status(400).json({ 
          success: false, 
          error: nameValidation.error,
          validationError: true,
          field: 'name'
        });
      }

      // Validate company name
      const companyValidation = validateCompanyName(finalCompanyName);
      if (!companyValidation.valid) {
        console.log(`❌ Portal lead validation failed (company): ${companyValidation.error}`);
        return res.status(400).json({ 
          success: false, 
          error: companyValidation.error,
          validationError: true,
          field: 'companyName'
        });
      }
      // ================================================================

      const userId = req.user?._id?.toString() || null;
      const userEmail = req.user?.email || null;
      const userName = req.user?.name || null;

      if (!userId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      // Check duplicate - using BOTH userId and visitorId for backward compat
      if (linkedinUrl) {
        const existing = await leadsCollection.findOne({ 
          linkedinUrl,
          $or: [
            { userId: userId },
            { visitorId: userId }
          ]
        });
        
        if (existing) {
          // ================================================================
          // UPDATE EXISTING LEAD DATA (not just lists!)
          // ================================================================
          const updateFields = {
            updatedAt: new Date(),
            lastScrapedAt: new Date()
          };

          // Update profile fields only if new values are provided and non-empty
          if (name && name.trim()) {
            updateFields.name = sanitizeString(name, 200);
          }
          
          const sanitizedCompanyName = sanitizeString(finalCompanyName, 200);
          if (sanitizedCompanyName) {
            updateFields.companyName = sanitizedCompanyName;
            updateFields.company = sanitizedCompanyName;
          }
          
          if (currentTitle && currentTitle.trim()) {
            updateFields.currentTitle = sanitizeString(currentTitle, 300);
            updateFields.title = sanitizeString(currentTitle, 300);
          } else if (title && title.trim()) {
            updateFields.currentTitle = sanitizeString(title, 300);
            updateFields.title = sanitizeString(title, 300);
          }
          
          if (headline && headline.trim()) {
            updateFields.headline = sanitizeString(headline, 500);
          }
          
          if (location && location.trim()) {
            updateFields.location = sanitizeString(location, 200);
          }

          // Smart email update logic:
          // Only update email if:
          // 1. New email is valid AND
          // 2. Either no existing email OR new email has higher confidence AND existing not verified
          const newEmailValid = email && email !== 'noemail@domain.com' && isValidEmail(email);
          const existingEmailValid = existing.email && existing.email !== 'noemail@domain.com' && isValidEmail(existing.email);
          const newEmailBetter = (emailConfidence || 0) > (existing.emailConfidence || 0);
          const existingNotVerified = existing.emailVerified !== true;

          if (newEmailValid && (!existingEmailValid || (newEmailBetter && existingNotVerified))) {
            updateFields.email = sanitizeString(email, 200);
            updateFields.emailSource = emailSource || 'scraped';
            updateFields.emailConfidence = emailConfidence || 0;
            updateFields.emailPattern = emailPattern || null;
            
            // Reset verification status if email changed
            if (existing.email !== email) {
              updateFields.emailVerified = null;
              updateFields.emailVerifiedAt = null;
              updateFields.emailVerificationMethod = null;
              updateFields.emailVerificationConfidence = null;
            }
          }

          // Build the update operation
          const updateOp = { $set: updateFields };
          
          // Add to lists if provided (using $addToSet to avoid duplicates)
          if (lists && lists.length > 0) {
            updateOp.$addToSet = { lists: { $each: lists } };
          }

          // Perform the update
          await leadsCollection.updateOne(
            { _id: existing._id },
            updateOp
          );

          // Ensure lists exist in portal_lists collection
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

          console.log(`✅ Lead updated: ${name} @ ${sanitizedCompanyName} (duplicate - data refreshed)`);
          
          return res.json({ 
            success: true, 
            duplicate: true, 
            updated: true, 
            leadId: existing._id,
            message: 'Lead updated with latest data'
          });
        }
      }

      // Sanitize company name
      const sanitizedCompanyName = sanitizeString(finalCompanyName, 200);
      
      // Determine sourcedBy (from request or user name)
      const finalSourcedBy = sanitizeString(sourcedBy, 200) || userName || null;

      // Create new lead with CONSISTENT field names
      const newLead = {
        // User identification - use userId (not visitorId)
        userId,
        userEmail,
        
        // Also store visitorId for backward compatibility with old code
        visitorId: userId,
        visitorEmail: userEmail,
        
        // Lead data - use consistent field names
        name: sanitizeString(name, 200),
        email: sanitizeString(email, 200) || null,
        
        // Company - store in BOTH fields for compatibility
        companyName: sanitizedCompanyName,
        company: sanitizedCompanyName,
        
        // Title/headline
        headline: sanitizeString(headline || title, 500) || null,
        currentTitle: sanitizeString(currentTitle || title, 300) || null,
        title: sanitizeString(title, 300) || null,
        
        // Other fields
        location: sanitizeString(location, 200) || null,
        linkedinUrl: sanitizeString(linkedinUrl, 500) || null,
        phone: sanitizeString(phone, 50) || null,
        profilePicture: sanitizeString(profilePicture, 500) || null,
        about: sanitizeString(about, 2000) || null,
        
        // Email metadata
        emailSource: emailSource || 'none',
        emailConfidence: emailConfidence || 0,
        emailPattern: emailPattern || null,
        emailVerified: null,
        
        // Sourcing
        sourcedBy: finalSourcedBy,
        leadSource: leadSource || 'extension',
        
        // Lists
        lists: lists || [],
        
        // Timestamps
        createdAt: new Date(),
        updatedAt: new Date(),
        savedAt: new Date(),
        lastScrapedAt: new Date()
      };

      const result = await leadsCollection.insertOne(newLead);

      // Create lists if provided
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

      // Increment usage
      await usersCollection.updateOne(
        { _id: req.user._id }, 
        { $inc: { 'usage.leadsScraped': 1 } }
      );

      console.log(`✅ Lead saved: ${name} @ ${sanitizedCompanyName} by ${userEmail}`);
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
        $or: [
          { userId: userId },
          { visitorId: userId }
        ]
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
        $or: [
          { userId: userId },
          { visitorId: userId }
        ]
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
        { 
          _id: new ObjectId(req.params.id), 
          $or: [{ userId }, { visitorId: userId }]
        },
        { $set: { lists, updatedAt: new Date() } }
      );

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
        { 
          _id: new ObjectId(req.params.id), 
          $or: [{ userId }, { visitorId: userId }]
        },
        { 
          $pull: { lists: decodeURIComponent(req.params.listName) }, 
          $set: { updatedAt: new Date() } 
        }
      );
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Remove from list error:', error);
      res.status(500).json({ success: false, error: 'Failed to remove from list' });
    }
  });

  // ==================== GET SINGLE LEAD ====================
  app.get('/api/portal/leads/:id', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      const lead = await leadsCollection.findOne({
        _id: new ObjectId(req.params.id),
        $or: [
          { userId: userId },
          { visitorId: userId }
        ]
      });

      if (!lead) {
        return res.status(404).json({ success: false, error: 'Lead not found' });
      }

      res.json({ success: true, lead });
    } catch (error) {
      console.error('❌ Get lead error:', error);
      res.status(500).json({ success: false, error: 'Failed to get lead' });
    }
  });

  // Create indexes for better performance
  leadsCollection.createIndex({ userId: 1, createdAt: -1 }).catch(() => {});
  leadsCollection.createIndex({ visitorId: 1, createdAt: -1 }).catch(() => {});
  leadsCollection.createIndex({ userId: 1, linkedinUrl: 1 }).catch(() => {});
  leadsCollection.createIndex({ visitorId: 1, linkedinUrl: 1 }).catch(() => {});
  leadsCollection.createIndex({ userId: 1, lists: 1 }).catch(() => {});

  console.log('✅ Portal Leads routes registered (FIXED with validation + duplicate updates)');
  console.log('   Validation: Name (no digits) and CompanyName required');
  console.log('   Duplicate handling: Now updates lead data on re-scrape');
}

function sanitizeString(str, maxLength = 500) {
  if (!str) return '';
  return String(str)
    .replace(/<[^>]*>/g, '')
    .replace(/['"\\]/g, '')
    .trim()
    .substring(0, maxLength);
}

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(e || '');
}

module.exports = { setupPortalLeadsRoutes };