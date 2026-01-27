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
      // Also filter out soft-deleted leads (deleted: true)
      const query = {
        $or: [
          { userId: userId },
          { visitorId: userId }
        ],
        deleted: { $ne: true }  // Exclude soft-deleted leads
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
          { deleted: { $ne: true } },  // Exclude soft-deleted leads
          searchQuery
        ];
        delete query.$or;
        delete query.deleted;
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
        notes,  // Notes array: [{ text: string, date: string }]
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

      // Check duplicate - using userId, visitorId, AND email for backward compat with migrated leads
      if (linkedinUrl) {
        const ownershipConditions = [
          { userId: userId },
          { visitorId: userId }
        ];
        // Also check email-based ownership (for leads migrated with userEmail/visitorEmail)
        if (userEmail) {
          ownershipConditions.push({ userEmail: userEmail });
          ownershipConditions.push({ visitorEmail: userEmail });
        }

        const existing = await leadsCollection.findOne({
          linkedinUrl,
          $or: ownershipConditions,
          deleted: { $ne: true }  // Don't match soft-deleted leads
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

          // Notes handling: merge new notes with existing notes
          if (notes && Array.isArray(notes) && notes.length > 0) {
            const existingNotes = existing.notes || [];
            // Add new notes that don't already exist (by text comparison)
            const existingTexts = new Set(existingNotes.map(n => n.text));
            const newNotes = notes.filter(n => n.text && !existingTexts.has(n.text));
            if (newNotes.length > 0) {
              updateFields.notes = [...existingNotes, ...newNotes];
            }
          }

          // Build the update operation
          const updateOp = { $set: updateFields };

          // Track which lists are new vs already present
          const existingLists = existing.lists || [];
          const newListsAdded = [];
          const alreadyInLists = [];

          // Add to lists if provided (using $addToSet to avoid duplicates)
          if (lists && lists.length > 0) {
            for (const listName of lists) {
              if (existingLists.includes(listName)) {
                alreadyInLists.push(listName);
              } else {
                newListsAdded.push(listName);
              }
            }
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

          // Determine the right message based on list status
          let message = 'Lead updated with latest data';
          let listStatus = 'none';

          if (newListsAdded.length > 0 && alreadyInLists.length === 0) {
            message = `Lead added to ${newListsAdded.join(', ')}`;
            listStatus = 'added';
          } else if (newListsAdded.length > 0 && alreadyInLists.length > 0) {
            message = `Lead added to ${newListsAdded.join(', ')} (already in ${alreadyInLists.join(', ')})`;
            listStatus = 'partial';
          } else if (alreadyInLists.length > 0 && newListsAdded.length === 0) {
            message = `Lead already in ${alreadyInLists.join(', ')}`;
            listStatus = 'already_in_list';
          }

          return res.json({
            success: true,
            duplicate: true,
            updated: true,
            leadId: existing._id,
            message,
            listStatus,
            newListsAdded,
            alreadyInLists,
            existingLists: [...existingLists, ...newListsAdded]
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

        // Notes - array of { text: string, date: string }
        notes: Array.isArray(notes) ? notes.filter(n => n && n.text) : [],

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

  // ==================== DELETE SINGLE LEAD (SOFT DELETE) ====================
  // Marks lead as deleted instead of removing from database
  // This preserves data for analytics while hiding from user's portal view
  console.log('🗑️ Registering DELETE /api/portal/leads/:id route in portal-leads.js');
  app.delete('/api/portal/leads/:id', auth, async (req, res) => {
    console.log(`🗑️ DELETE request received for lead: ${req.params.id} by user: ${req.user?.email}`);
    try {
      const userId = req.user._id.toString();
      const leadId = req.params.id;
      console.log(`🗑️ Processing delete - userId: ${userId}, leadId: ${leadId}`);

      // First, find the lead to check ownership and debug
      const lead = await leadsCollection.findOne({ _id: new ObjectId(leadId) });

      if (!lead) {
        console.log(`❌ Delete failed: Lead ${leadId} not found in database`);
        return res.status(404).json({ success: false, error: 'Lead not found' });
      }

      // Check ownership - allow if userId, visitorId, visitorEmail, or userEmail matches
      const userEmail = req.user.email;
      const isOwner = lead.userId === userId ||
                      lead.visitorId === userId ||
                      lead.visitorEmail === userEmail ||
                      lead.userEmail === userEmail;

      // Check if lead is truly orphaned (no ownership data at all)
      const isOrphaned = !lead.userId && !lead.visitorId && !lead.visitorEmail && !lead.userEmail;

      if (!isOwner && !isOrphaned) {
        console.log(`❌ Delete failed: User ${userId} (${userEmail}) does not own lead ${leadId}`);
        console.log(`   Lead userId: ${lead.userId}, visitorId: ${lead.visitorId}, visitorEmail: ${lead.visitorEmail}, userEmail: ${lead.userEmail}`);
        return res.status(404).json({ success: false, error: 'Lead not found' });
      }

      if (isOrphaned) {
        console.log(`⚠️ Lead ${leadId} is orphaned (no ownership data) - allowing delete and claiming ownership`);
      }

      // If lead doesn't have userId/visitorId, update it now (fix orphaned leads)
      if (!lead.userId || !lead.visitorId) {
        console.log(`🔧 Fixing orphaned lead ${leadId} - setting userId/visitorId to ${userId}`);
        await leadsCollection.updateOne(
          { _id: new ObjectId(leadId) },
          { $set: { userId: userId, visitorId: userId } }
        );
      }

      // Soft delete: set deleted flag instead of removing
      const result = await leadsCollection.updateOne(
        { _id: new ObjectId(leadId) },
        {
          $set: {
            deleted: true,
            deletedAt: new Date(),
            deletedBy: req.user.email,
            updatedAt: new Date()
          }
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ success: false, error: 'Lead not found' });
      }

      console.log(`✅ Lead ${leadId} soft-deleted by ${req.user.email}`);
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Delete lead error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete lead' });
    }
  });

  // ==================== BULK DELETE LEADS (SOFT DELETE) ====================
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

      // Soft delete: mark as deleted instead of removing
      const result = await leadsCollection.updateMany(
        {
          _id: { $in: objectIds },
          $or: [
            { userId: userId },
            { visitorId: userId }
          ]
        },
        {
          $set: {
            deleted: true,
            deletedAt: new Date(),
            deletedBy: req.user.email,
            updatedAt: new Date()
          }
        }
      );

      console.log(`✅ Bulk soft-deleted ${result.modifiedCount} leads by ${req.user.email}`);
      res.json({ success: true, deletedCount: result.modifiedCount });
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

  // ==================== LOOKUP LEAD BY LINKEDIN URL (WITH NOTES) ====================
  // IMPORTANT: This route MUST be defined BEFORE the :id route to avoid "lookup" being treated as an ID
  app.get('/api/portal/leads/lookup', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      const { linkedinUrl } = req.query;

      if (!linkedinUrl) {
        return res.status(400).json({ success: false, error: 'linkedinUrl parameter required' });
      }

      // Normalize URL for flexible matching (handle trailing slashes, query params)
      const normalizedUrl = linkedinUrl.replace(/\/$/, '').toLowerCase();
      const profileId = normalizedUrl.split('/in/')[1]?.split('/')[0]?.split('?')[0];

      // Build query with multiple URL variations for better matching
      const urlVariations = [
        linkedinUrl,
        linkedinUrl.replace(/\/$/, ''),
        linkedinUrl + '/',
        linkedinUrl.toLowerCase(),
        linkedinUrl.toLowerCase().replace(/\/$/, ''),
      ];

      // Add profile ID regex if we can extract it
      // Build URL matching conditions
      const urlConditions = profileId
        ? [
            { linkedinUrl: { $in: urlVariations } },
            { linkedinUrl: { $regex: new RegExp(`/in/${profileId}/?$`, 'i') } }
          ]
        : [{ linkedinUrl: { $in: urlVariations } }];

      // User ownership condition
      const userCondition = { $or: [{ userId: userId }, { visitorId: userId }] };

      // Combine with $and to avoid $or key collision
      // Also exclude soft-deleted leads
      const lead = await leadsCollection.findOne({
        $and: [
          { $or: urlConditions },
          userCondition,
          { deleted: { $ne: true } }
        ]
      });

      if (!lead) {
        return res.json({ success: true, exists: false, lead: null });
      }

      res.json({
        success: true,
        exists: true,
        lead: {
          _id: lead._id,
          name: lead.name,
          email: lead.email,
          company: lead.company || lead.companyName,
          companyName: lead.companyName,
          title: lead.title || lead.currentTitle,
          headline: lead.headline,
          location: lead.location,
          linkedinUrl: lead.linkedinUrl,
          lists: lead.lists || [],
          notes: lead.notes || [],
          createdAt: lead.createdAt,
          updatedAt: lead.updatedAt
        }
      });
    } catch (error) {
      console.error('❌ Lookup lead error:', error);
      res.status(500).json({ success: false, error: 'Failed to lookup lead' });
    }
  });

  // ==================== GET SINGLE LEAD ====================
  app.get('/api/portal/leads/:id', auth, async (req, res) => {
    // Validate that id is a valid 24-char hex string (ObjectId format)
    if (!/^[a-fA-F0-9]{24}$/.test(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid lead ID format' });
    }

    try {
      const userId = req.user._id.toString();
      const lead = await leadsCollection.findOne({
        _id: new ObjectId(req.params.id),
        $or: [
          { userId: userId },
          { visitorId: userId }
        ],
        deleted: { $ne: true }  // Exclude soft-deleted leads
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

  // ==================== UPDATE LEAD (GENERAL) ====================
  app.put('/api/portal/leads/:id', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      const { notes, ...otherFields } = req.body;

      const updateFields = { updatedAt: new Date() };

      // Handle notes update
      if (notes !== undefined) {
        updateFields.notes = Array.isArray(notes) ? notes.filter(n => n && n.text) : [];
      }

      // Handle other allowed fields
      const allowedFields = ['name', 'title', 'headline', 'company', 'companyName', 'location', 'phone', 'about'];
      for (const field of allowedFields) {
        if (otherFields[field] !== undefined) {
          updateFields[field] = sanitizeString(otherFields[field], field === 'about' ? 2000 : 500);
        }
      }

      const result = await leadsCollection.updateOne(
        {
          _id: new ObjectId(req.params.id),
          $or: [{ userId }, { visitorId: userId }]
        },
        { $set: updateFields }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ success: false, error: 'Lead not found' });
      }

      console.log(`✅ Lead ${req.params.id} updated by ${req.user.email}`);
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Update lead error:', error);
      res.status(500).json({ success: false, error: 'Failed to update lead' });
    }
  });

  // ==================== UPDATE LEAD NOTES ====================
  app.put('/api/portal/leads/:id/notes', auth, async (req, res) => {
    try {
      const userId = req.user._id.toString();
      const { notes } = req.body;

      if (!Array.isArray(notes)) {
        return res.status(400).json({ success: false, error: 'Notes must be an array' });
      }

      // Validate and sanitize notes
      const sanitizedNotes = notes
        .filter(n => n && n.text)
        .map(n => ({
          text: sanitizeString(n.text, 1000),
          date: n.date || new Date().toLocaleDateString()
        }));

      const result = await leadsCollection.updateOne(
        {
          _id: new ObjectId(req.params.id),
          $or: [{ userId }, { visitorId: userId }]
        },
        { $set: { notes: sanitizedNotes, updatedAt: new Date() } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ success: false, error: 'Lead not found' });
      }

      console.log(`✅ Notes updated for lead ${req.params.id} by ${req.user.email}`);
      res.json({ success: true, notes: sanitizedNotes });
    } catch (error) {
      console.error('❌ Update notes error:', error);
      res.status(500).json({ success: false, error: 'Failed to update notes' });
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