// ============================================================================
// auth.js - ADDITIVE Authentication Module for Brynsa Portal
// ============================================================================
// 
// SAFE ROLLOUT: This file ONLY ADDS new endpoints. It does NOT modify
// any existing routes or functionality. Your extension will continue
// to work exactly as before.
//
// UPDATED: Routes now use optionalAuthMiddleware for backward compatibility
// with the old extension that doesn't send auth tokens.
//
// UPDATE 2: Added automatic lead linking on signup - when a user signs up,
// their existing leads (by visitorEmail) are automatically linked to their account.
//
// ============================================================================

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// ============================================================================
// CONFIGURATION
// ============================================================================

// SECURITY: JWT_SECRET is required - no fallback to prevent accidental use of weak secret
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET environment variable is required');
  console.error('   Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
const JWT_EXPIRY = '30d';
const OTP_EXPIRY_MINUTES = 10;

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// Feature gates - DISABLED by default for safe rollout
const FEATURE_GATES_ENABLED = process.env.FEATURE_GATES_ENABLED === 'true';

const FREE_PLAN_FEATURES = {
  linkedinScraping: true,
  emailEnrichment: true,
  emailGeneration: false,
  dmGeneration: false,
  noteGeneration: false,
  crmExport: false,
  bulkExport: false,
};

const PRO_PLAN_FEATURES = {
  linkedinScraping: true,
  emailEnrichment: true,
  emailGeneration: true,
  dmGeneration: true,
  noteGeneration: true,
  crmExport: true,
  bulkExport: true,
};

// ============================================================================
// HELPER: Link existing leads to new user
// ============================================================================

async function linkExistingLeadsToUser(userId, userEmail, userName, leadsCollection) {
  const normalizedEmail = userEmail.toLowerCase().trim();
  const normalizedName = (userName || '').toLowerCase().trim();
  const userIdStr = userId.toString();
  
  let totalLinked = 0;
  
  try {
    // ================================================================
    // STEP 1: Link by email (visitorEmail or userEmail)
    // This has highest priority - most reliable match
    // ================================================================
    const emailResult = await leadsCollection.updateMany(
      {
        $or: [
          { visitorEmail: { $regex: new RegExp(`^${escapeRegex(normalizedEmail)}$`, 'i') } },
          { userEmail: { $regex: new RegExp(`^${escapeRegex(normalizedEmail)}$`, 'i') } }
        ]
      },
      {
        $set: {
          userId: userIdStr,
          userEmail: normalizedEmail,
          linkedAt: new Date(),
          linkedBy: 'email_match'
        }
      }
    );

    if (emailResult.modifiedCount > 0) {
      console.log(`🔗 Linked ${emailResult.modifiedCount} leads by email: ${normalizedEmail}`);
      totalLinked += emailResult.modifiedCount;
    }

    // ================================================================
    // STEP 2: Link by sourcedBy (case-insensitive name match)
    // Only for leads that don't already have a userId
    // ================================================================
    if (normalizedName && normalizedName.length >= 2) {
      const sourcedByResult = await leadsCollection.updateMany(
        {
          // Match sourcedBy case-insensitively
          sourcedBy: { $regex: new RegExp(`^${escapeRegex(normalizedName)}$`, 'i') },
          // Only link leads that don't already have a userId
          $or: [
            { userId: { $exists: false } },
            { userId: null },
            { userId: '' }
          ]
        },
        {
          $set: {
            userId: userIdStr,
            userEmail: normalizedEmail,
            linkedAt: new Date(),
            linkedBy: 'sourcedBy_match'
          }
        }
      );

      if (sourcedByResult.modifiedCount > 0) {
        console.log(`🔗 Linked ${sourcedByResult.modifiedCount} leads by sourcedBy: ${userName}`);
        totalLinked += sourcedByResult.modifiedCount;
      }
    }

    // ================================================================
    // STEP 3: Also update any leads that have OLD userId but matching email
    // This handles the case where user deletes account and signs up again
    // ================================================================
    const reAssignResult = await leadsCollection.updateMany(
      {
        $or: [
          { visitorEmail: { $regex: new RegExp(`^${escapeRegex(normalizedEmail)}$`, 'i') } },
          { userEmail: { $regex: new RegExp(`^${escapeRegex(normalizedEmail)}$`, 'i') } }
        ],
        userId: { $exists: true, $ne: userIdStr }  // Has a DIFFERENT userId
      },
      {
        $set: {
          userId: userIdStr,
          userEmail: normalizedEmail,
          linkedAt: new Date(),
          linkedBy: 'email_reassign'
        }
      }
    );

    if (reAssignResult.modifiedCount > 0) {
      console.log(`🔗 Re-assigned ${reAssignResult.modifiedCount} leads with old userId to new user: ${normalizedEmail}`);
      totalLinked += reAssignResult.modifiedCount;
    }

    return { success: true, linkedCount: totalLinked };
  } catch (error) {
    console.error('Failed to link leads:', error);
    return { success: false, linkedCount: 0, error: error.message };
  }
}

// Helper to escape special regex characters
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// SETUP AUTH ROUTES (ADDITIVE - doesn't modify existing routes)
// ============================================================================

function setupAuthRoutes(app, db) {
  const users = db.collection('portal_users'); // NEW collection - won't conflict
  const otpCodes = db.collection('otp_codes');
  const companies = db.collection('companies'); // Company details collection
  const leads = db.collection('leads'); // Use existing leads collection

  // Create indexes
  users.createIndex({ email: 1 }, { unique: true }).catch(() => {});
  users.createIndex({ googleId: 1 }, { sparse: true }).catch(() => {});
  otpCodes.createIndex({ email: 1 }).catch(() => {});
  otpCodes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
  
  // Company indexes
  companies.createIndex({ name: 1 }, { unique: true }).catch(() => {});
  companies.createIndex({ normalizedName: 1 }).catch(() => {});
  companies.createIndex({ linkedinUrl: 1 }, { sparse: true }).catch(() => {});
  companies.createIndex({ domain: 1 }, { sparse: true }).catch(() => {});
  
  // Leads indexes (for portal users)
  leads.createIndex({ visitorId: 1 }).catch(() => {}); // visitorId = portal userId
  leads.createIndex({ leadSource: 1 }).catch(() => {});

  // ========================================================================
  // POST /api/auth/send-otp - Send OTP to email
  // ========================================================================
  app.post('/api/auth/send-otp', async (req, res) => {
    try {
      const { email, isSignup } = req.body;

      if (!email || !isValidEmail(email)) {
        return res.status(400).json({ success: false, error: 'Valid email is required' });
      }

      const normalizedEmail = email.toLowerCase().trim();

      // Check if user exists (only for signup flow)
      if (isSignup) {
        const existingUser = await users.findOne({ email: normalizedEmail });
        if (existingUser) {
          return res.status(400).json({ 
            success: false, 
            error: 'Account already exists',
            code: 'USER_EXISTS'
          });
        }
      }

      const otp = generateOTP();
      const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

      await otpCodes.deleteMany({ email: normalizedEmail });
      await otpCodes.insertOne({
        email: normalizedEmail,
        otp,
        expiresAt,
        verified: false,
        createdAt: new Date()
      });

      // Send OTP via email
      try {
        await resend.emails.send({
          from: 'Brynsa <noreply@huemot.com>',
          to: normalizedEmail,
          subject: 'Your Brynsa verification code',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #22c55e; margin-bottom: 20px;">Verify your email</h2>
              <p style="color: #333; font-size: 16px;">Your verification code is:</p>
              <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #111;">${otp}</span>
              </div>
              <p style="color: #666; font-size: 14px;">This code expires in 10 minutes.</p>
              <p style="color: #666; font-size: 14px;">If you didn't request this code, you can safely ignore this email.</p>
              <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
              <p style="color: #999; font-size: 12px;">© Brynsa - LinkedIn Lead Extractor</p>
            </div>
          `
        });
        console.log(`📧 OTP sent to ${normalizedEmail}`);
      } catch (emailError) {
        console.error('Failed to send email:', emailError);
        console.log(`📧 OTP for ${normalizedEmail}: ${otp}`);
      }

      res.json({ 
        success: true, 
        message: 'OTP sent to email'
      });

    } catch (error) {
      console.error('❌ Send OTP error:', error);
      res.status(500).json({ success: false, error: 'Failed to send OTP' });
    }
  });

  // ========================================================================
  // POST /api/auth/verify-otp - Verify OTP and login/register (legacy)
  // ========================================================================
  app.post('/api/auth/verify-otp', async (req, res) => {
    try {
      const { email, otp } = req.body;

      if (!email || !otp) {
        return res.status(400).json({ success: false, error: 'Email and OTP are required' });
      }

      const normalizedEmail = email.toLowerCase().trim();

      const otpRecord = await otpCodes.findOne({
        email: normalizedEmail,
        otp: otp.toString(),
        expiresAt: { $gt: new Date() }
      });

      if (!otpRecord) {
        return res.status(401).json({ success: false, error: 'Invalid or expired OTP' });
      }

      await otpCodes.deleteMany({ email: normalizedEmail });

      const user = await findOrCreateUser(users, { email: normalizedEmail });
      const token = generateToken(user);

      await users.updateOne(
        { _id: user._id },
        { $set: { lastLogin: new Date() } }
      );

      res.json({
        success: true,
        token,
        user: sanitizeUser(user)
      });

    } catch (error) {
      console.error('❌ Verify OTP error:', error);
      res.status(500).json({ success: false, error: 'Verification failed' });
    }
  });

  // ========================================================================
  // POST /api/auth/verify-otp-only - Verify OTP without creating user
  // Used for password setup flow
  // ========================================================================
  app.post('/api/auth/verify-otp-only', async (req, res) => {
    try {
      const { email, otp } = req.body;

      if (!email || !otp) {
        return res.status(400).json({ success: false, error: 'Email and OTP required' });
      }

      const normalizedEmail = email.toLowerCase().trim();

      const otpRecord = await otpCodes.findOne({
        email: normalizedEmail,
        otp: otp.toString(),
        expiresAt: { $gt: new Date() }
      });

      if (!otpRecord) {
        return res.status(400).json({ success: false, error: 'Invalid or expired OTP' });
      }

      // Mark OTP as verified (don't delete yet - needed for signup)
      await otpCodes.updateOne(
        { _id: otpRecord._id },
        { $set: { verified: true, verifiedAt: new Date() } }
      );

      res.json({ success: true, message: 'OTP verified' });

    } catch (error) {
      console.error('OTP verify-only error:', error);
      res.status(500).json({ success: false, error: 'Verification failed' });
    }
  });

  // ========================================================================
  // POST /api/auth/signup - Complete signup with name and password
  // UPDATED: Now automatically links existing leads to new user
  // ========================================================================
  app.post('/api/auth/signup', async (req, res) => {
    try {
      const { email, otp, name, password } = req.body;

      if (!email || !otp || !name || !password) {
        return res.status(400).json({ success: false, error: 'All fields required' });
      }

      if (password.length < 10) {
        return res.status(400).json({ success: false, error: 'Password must be at least 10 characters' });
      }

      const normalizedEmail = email.toLowerCase().trim();

      // Find verified OTP
      const otpRecord = await otpCodes.findOne({
        email: normalizedEmail,
        otp: otp.toString(),
        verified: true,
        expiresAt: { $gt: new Date() }
      });

      if (!otpRecord) {
        return res.status(400).json({ success: false, error: 'Invalid or expired OTP. Please request a new code.' });
      }

      // Check if user already exists
      const existingUser = await users.findOne({ email: normalizedEmail });
      if (existingUser) {
        return res.status(400).json({ success: false, error: 'Account already exists. Please login.' });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 12);

      // Create user
      const newUser = {
        email: normalizedEmail,
        name: sanitizeString(name, 100),
        password: hashedPassword,
        picture: null,
        googleId: null,
        plan: 'free',
        features: FREE_PLAN_FEATURES,
        usage: {
          leadsScraped: 0,
          emailsGenerated: 0,
          dmsGenerated: 0,
          notesGenerated: 0,
          crmExports: 0
        },
        onboarding: {
          completed: false
        },
        source: 'portal',
        createdAt: new Date(),
        lastLogin: new Date()
      };

      const result = await users.insertOne(newUser);
      const user = { ...newUser, _id: result.insertedId };
      const userId = result.insertedId.toString();

      // Delete used OTP
      await otpCodes.deleteMany({ email: normalizedEmail });

      // ================================================================
      // 🔗 AUTO-LINK EXISTING LEADS TO NEW USER
      // ================================================================
      // When a user signs up, automatically find and link any leads
      // that were created with their email OR sourcedBy their name
      const linkResult = await linkExistingLeadsToUser(userId, normalizedEmail, newUser.name, leads);
      // ================================================================

      // Generate token
      const token = generateToken(user);

      console.log(`👤 New user signed up: ${normalizedEmail}${linkResult.linkedCount > 0 ? ` (linked ${linkResult.linkedCount} existing leads)` : ''}`);

      res.json({
        success: true,
        token,
        user: sanitizeUser(user),
        linkedLeads: linkResult.linkedCount // Optional: let frontend know how many leads were linked
      });

    } catch (error) {
      console.error('Signup error:', error);
      res.status(500).json({ success: false, error: 'Signup failed' });
    }
  });

  // ========================================================================
  // POST /api/auth/login - Login with email and password
  // ========================================================================
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password required' });
      }

      const normalizedEmail = email.toLowerCase().trim();

      // Find user
      const user = await users.findOne({ email: normalizedEmail });
      
      if (!user) {
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
      }

      // Check if user has password (might be Google-only user)
      if (!user.password) {
        return res.status(401).json({ success: false, error: 'Please login with Google or reset your password' });
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.password);
      
      if (!isValidPassword) {
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
      }

      // Update last login
      await users.updateOne(
        { _id: user._id },
        { $set: { lastLogin: new Date() } }
      );

      // Generate token
      const token = generateToken(user);

      console.log(`🔐 User logged in: ${normalizedEmail}`);

      res.json({
        success: true,
        token,
        user: sanitizeUser(user)
      });

    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ success: false, error: 'Login failed' });
    }
  });

  // ========================================================================
  // POST /api/auth/google - Google OAuth login/signup (FOR PORTAL ONLY)
  // UPDATED: Now automatically links existing leads for new Google users
  // SECURITY: Now properly verifies Google tokens server-side
  // ========================================================================
  app.post('/api/auth/google', async (req, res) => {
    try {
      const { credential, isLogin, isSignup } = req.body;

      if (!credential) {
        return res.status(400).json({ success: false, error: 'Google credential is required' });
      }

      // SECURITY: Verify the Google token server-side instead of just decoding
      const decoded = await verifyGoogleToken(credential);

      if (!decoded || !decoded.email) {
        return res.status(401).json({ success: false, error: 'Invalid or expired Google credential' });
      }

      const normalizedEmail = decoded.email.toLowerCase();
      const existingUser = await users.findOne({ email: normalizedEmail });

      // For login: user must exist
      if (isLogin && !existingUser) {
        return res.status(401).json({ 
          success: false, 
          error: 'User not found',
          code: 'USER_NOT_FOUND'
        });
      }

      // For signup: user must NOT exist (or allow linking Google to existing account)
      if (isSignup && existingUser && existingUser.googleId) {
        return res.status(400).json({ 
          success: false, 
          error: 'Account already exists. Please log in instead.',
          code: 'USER_EXISTS'
        });
      }

      // Find or create user
      let user;
      let isNewUser = false;
      
      if (existingUser) {
        // Update existing user with Google info if not already linked
        if (!existingUser.googleId) {
          await users.updateOne(
            { _id: existingUser._id },
            { 
              $set: { 
                googleId: decoded.googleId,
                picture: decoded.picture || existingUser.picture,
                name: existingUser.name || decoded.name,
                lastLogin: new Date()
              } 
            }
          );
        } else {
          await users.updateOne(
            { _id: existingUser._id },
            { $set: { lastLogin: new Date() } }
          );
        }
        user = await users.findOne({ _id: existingUser._id });
      } else {
        // Create new user
        isNewUser = true;
        const newUser = {
          email: normalizedEmail,
          name: decoded.name || normalizedEmail.split('@')[0],
          picture: decoded.picture || null,
          googleId: decoded.googleId,
          password: null, // Google users don't have password initially
          plan: 'free',
          features: FREE_PLAN_FEATURES,
          usage: {
            leadsScraped: 0,
            emailsGenerated: 0,
            dmsGenerated: 0,
            notesGenerated: 0,
            crmExports: 0
          },
          onboarding: {
            completed: false
          },
          source: 'portal-google',
          createdAt: new Date(),
          lastLogin: new Date()
        };

        const result = await users.insertOne(newUser);
        user = { ...newUser, _id: result.insertedId };
        console.log(`👤 New Google user created: ${normalizedEmail}`);
      }

      // ================================================================
      // 🔗 AUTO-LINK EXISTING LEADS FOR NEW GOOGLE USERS
      // ================================================================
      let linkedLeadsCount = 0;
      if (isNewUser) {
        const linkResult = await linkExistingLeadsToUser(user._id.toString(), normalizedEmail, user.name, leads);
        linkedLeadsCount = linkResult.linkedCount;
        if (linkedLeadsCount > 0) {
          console.log(`🔗 Linked ${linkedLeadsCount} existing leads to new Google user: ${normalizedEmail}`);
        }
      }
      // ================================================================

      const token = generateToken(user);

      console.log(`🔐 Google auth successful: ${normalizedEmail}`);

      res.json({
        success: true,
        token,
        user: sanitizeUser(user),
        linkedLeads: linkedLeadsCount // Optional: let frontend know how many leads were linked
      });

    } catch (error) {
      console.error('❌ Google auth error:', error);
      res.status(500).json({ success: false, error: 'Google authentication failed' });
    }
  });

  // ========================================================================
  // GET /api/user/profile - Get current user profile
  // ========================================================================
  app.get('/api/user/profile', authMiddleware(users), async (req, res) => {
    try {
      res.json({
        success: true,
        user: sanitizeUser(req.user)
      });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to get profile' });
    }
  });

  // ========================================================================
  // PUT /api/user/profile - Update user profile
  // ========================================================================
  app.put('/api/user/profile', authMiddleware(users), async (req, res) => {
    try {
      const { name, picture } = req.body;
      const updates = {};

      if (name) updates.name = sanitizeString(name, 100);
      if (picture) updates.picture = sanitizeString(picture, 500);

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ success: false, error: 'No valid fields to update' });
      }

      updates.updatedAt = new Date();

      await users.updateOne(
        { _id: req.user._id },
        { $set: updates }
      );

      const updatedUser = await users.findOne({ _id: req.user._id });

      res.json({
        success: true,
        user: sanitizeUser(updatedUser)
      });

    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to update profile' });
    }
  });

  // ========================================================================
  // GET /api/user/features - Get user's available features
  // ========================================================================
  app.get('/api/user/features', authMiddleware(users), async (req, res) => {
    try {
      const user = req.user;
      const features = user.plan === 'pro' ? PRO_PLAN_FEATURES : FREE_PLAN_FEATURES;

      res.json({
        success: true,
        plan: user.plan || 'free',
        features,
        featureGatesEnabled: FEATURE_GATES_ENABLED,
        usage: user.usage || {
          leadsScraped: 0,
          emailsGenerated: 0,
          dmsGenerated: 0,
          notesGenerated: 0,
          crmExports: 0
        }
      });

    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to get features' });
    }
  });

  // ========================================================================
  // POST /api/user/onboarding - Save onboarding questionnaire
  // ========================================================================
  app.post('/api/user/onboarding', authMiddleware(users), async (req, res) => {
    try {
      const { companyName, role, teamSize, useCase } = req.body;

      const sanitizedCompanyName = sanitizeString(companyName, 200);
      
      // Create or update company if company name provided
      if (sanitizedCompanyName) {
        const normalizedName = sanitizedCompanyName.toLowerCase().trim();
        
        await companies.updateOne(
          { normalizedName },
          {
            $set: {
              name: sanitizedCompanyName,
              normalizedName,
              updatedAt: new Date()
            },
            $setOnInsert: {
              createdAt: new Date(),
              source: 'onboarding',
              createdBy: req.user._id
            }
          },
          { upsert: true }
        );

        // Get company ID and link to user
        const company = await companies.findOne({ normalizedName });
        
        await users.updateOne(
          { _id: req.user._id },
          {
            $set: {
              companyId: company._id,
              onboarding: {
                completed: true,
                companyName: sanitizedCompanyName,
                role: sanitizeString(role, 100),
                teamSize: sanitizeString(teamSize, 50),
                useCase: sanitizeString(useCase, 100),
                completedAt: new Date()
              }
            }
          }
        );
      } else {
        await users.updateOne(
          { _id: req.user._id },
          {
            $set: {
              onboarding: {
                completed: true,
                companyName: '',
                role: sanitizeString(role, 100),
                teamSize: sanitizeString(teamSize, 50),
                useCase: sanitizeString(useCase, 100),
                completedAt: new Date()
              }
            }
          }
        );
      }

      res.json({ success: true, message: 'Onboarding completed' });

    } catch (error) {
      console.error('Onboarding error:', error);
      res.status(500).json({ success: false, error: 'Failed to save onboarding' });
    }
  });

  // ========================================================================
  // GET /api/companies/search - Search companies by name (autocomplete)
  // ========================================================================
  app.get('/api/companies/search', async (req, res) => {
    try {
      const { q } = req.query;
      
      if (!q || q.length < 2) {
        return res.json({ success: true, companies: [] });
      }

      const searchTerm = q.toLowerCase().trim();
      
      const results = await companies.find({
        normalizedName: { $regex: searchTerm, $options: 'i' }
      })
      .project({ 
        _id: 1, 
        name: 1, 
        domain: 1, 
        industry: 1, 
        logo: 1,
        linkedinUrl: 1,
        employeeCount: 1
      })
      .limit(10)
      .toArray();

      res.json({ success: true, companies: results });

    } catch (error) {
      console.error('Company search error:', error);
      res.status(500).json({ success: false, error: 'Search failed' });
    }
  });

  // ========================================================================
  // POST /api/companies - Create or update company (for extension)
  // ========================================================================
  app.post('/api/companies', async (req, res) => {
    try {
      const { 
        name, 
        linkedinUrl, 
        domain, 
        industry, 
        employeeCount, 
        description,
        logo,
        headquarters,
        website,
        founded
      } = req.body;

      if (!name) {
        return res.status(400).json({ success: false, error: 'Company name is required' });
      }

      const sanitizedName = sanitizeString(name, 200);
      const normalizedName = sanitizedName.toLowerCase().trim();

      const updateData = {
        name: sanitizedName,
        normalizedName,
        updatedAt: new Date()
      };

      // Add optional fields if provided
      if (linkedinUrl) updateData.linkedinUrl = sanitizeString(linkedinUrl, 500);
      if (domain) updateData.domain = sanitizeString(domain, 200);
      if (industry) updateData.industry = sanitizeString(industry, 100);
      if (employeeCount) updateData.employeeCount = sanitizeString(employeeCount, 50);
      if (description) updateData.description = sanitizeString(description, 2000);
      if (logo) updateData.logo = sanitizeString(logo, 500);
      if (headquarters) updateData.headquarters = sanitizeString(headquarters, 200);
      if (website) updateData.website = sanitizeString(website, 500);
      if (founded) updateData.founded = sanitizeString(founded, 20);

      const result = await companies.updateOne(
        { normalizedName },
        {
          $set: updateData,
          $setOnInsert: {
            createdAt: new Date(),
            source: req.body.source || 'extension'
          }
        },
        { upsert: true }
      );

      const company = await companies.findOne({ normalizedName });

      res.json({ 
        success: true, 
        company: {
          id: company._id,
          name: company.name,
          linkedinUrl: company.linkedinUrl,
          domain: company.domain,
          industry: company.industry,
          employeeCount: company.employeeCount
        },
        created: result.upsertedCount > 0
      });

    } catch (error) {
      console.error('Company create/update error:', error);
      res.status(500).json({ success: false, error: 'Failed to save company' });
    }
  });

  // ========================================================================
  // GET /api/companies/:id - Get company details
  // ========================================================================
  app.get('/api/companies/:id', async (req, res) => {
    try {
      const { ObjectId } = require('mongodb');
      const companyId = req.params.id;

      let company;
      
      // Try to find by ObjectId first, then by normalized name
      try {
        company = await companies.findOne({ _id: new ObjectId(companyId) });
      } catch {
        company = await companies.findOne({ normalizedName: companyId.toLowerCase() });
      }

      if (!company) {
        return res.status(404).json({ success: false, error: 'Company not found' });
      }

      res.json({ success: true, company });

    } catch (error) {
      console.error('Get company error:', error);
      res.status(500).json({ success: false, error: 'Failed to get company' });
    }
  });

  // ========================================================================
  // POST /api/user/increment-usage - Track feature usage
  // ========================================================================
  app.post('/api/user/increment-usage', authMiddleware(users), async (req, res) => {
    try {
      const { feature } = req.body;
      const validFeatures = ['leadsScraped', 'emailsGenerated', 'dmsGenerated', 'notesGenerated', 'crmExports'];

      if (!feature || !validFeatures.includes(feature)) {
        return res.status(400).json({ success: false, error: 'Invalid feature' });
      }

      await users.updateOne(
        { _id: req.user._id },
        { $inc: { [`usage.${feature}`]: 1 } }
      );

      res.json({ success: true });

    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to update usage' });
    }
  });

  // ========================================================================
  // GET /api/portal/leads - Get user's saved leads (PORTAL ONLY - requires auth)
  // RENAMED to avoid conflict with public /api/leads
  // ========================================================================
  app.get('/api/portal/leads', authMiddleware(users), async (req, res) => {
    try {
      // Use visitorId to match existing leads schema
      // visitorId can be the user's _id (as string) or email
      const userLeads = await leads.find({ 
        $or: [
          { visitorId: req.user._id.toString() },
          { visitorId: req.user.email },
          { visitorEmail: req.user.email },
          { userId: req.user._id.toString() },  // Also check userId field
          { sourcedBy: { $regex: new RegExp(`^${escapeRegex(req.user.name || '')}$`, 'i') } }  // Match by name
        ]
      })
        .sort({ createdAt: -1 })
        .toArray();

      res.json({ success: true, leads: userLeads });

    } catch (error) {
      console.error('Get leads error:', error);
      res.status(500).json({ success: false, error: 'Failed to get leads' });
    }
  });

  // ========================================================================
  // GET /api/portal/leads/:id - Get single lead (PORTAL ONLY)
  // Skip if :id is not a valid ObjectId (let other routes handle it)
  // ========================================================================
  app.get('/api/portal/leads/:id', authMiddleware(users), async (req, res, next) => {
    try {
      const { ObjectId } = require('mongodb');

      // Validate that id is a valid 24-char hex string (ObjectId format)
      // If not, pass to the next route handler (e.g., /lookup)
      if (!/^[a-fA-F0-9]{24}$/.test(req.params.id)) {
        return next('route');
      }

      const lead = await leads.findOne({
        _id: new ObjectId(req.params.id),
        $or: [
          { visitorId: req.user._id.toString() },
          { visitorId: req.user.email },
          { visitorEmail: req.user.email },
          { userId: req.user._id.toString() }
        ]
      });

      if (!lead) {
        return res.status(404).json({ success: false, error: 'Lead not found' });
      }

      res.json({ success: true, lead });

    } catch (error) {
      console.error('Get lead error:', error);
      res.status(500).json({ success: false, error: 'Failed to get lead' });
    }
  });

  // ========================================================================
  // POST /api/portal/leads - Save a new lead (PORTAL ONLY - requires auth)
  // RENAMED to avoid conflict with public /api/leads
  // ========================================================================
  app.post('/api/portal/leads', authMiddleware(users), async (req, res) => {
    try {
      const { 
        name, title, company, companyId, location, 
        linkedinUrl, profilePicture, email, phone,
        about, leadSource 
      } = req.body;

      if (!name && !linkedinUrl) {
        return res.status(400).json({ success: false, error: 'Name or LinkedIn URL required' });
      }

      // Check for duplicate using visitorId or email
      if (linkedinUrl) {
        const existing = await leads.findOne({ 
          linkedinUrl,
          $or: [
            { visitorId: req.user._id.toString() },
            { visitorId: req.user.email },
            { visitorEmail: req.user.email },
            { userId: req.user._id.toString() }
          ]
        });
        if (existing) {
          return res.json({ success: true, lead: existing, duplicate: true });
        }
      }

      const newLead = {
        // Use existing schema field names
        visitorId: req.user._id.toString(),
        visitorEmail: req.user.email,
        userId: req.user._id.toString(),  // Also set userId
        userEmail: req.user.email,
        name: sanitizeString(name, 200),
        title: sanitizeString(title, 300),
        company: sanitizeString(company, 200),
        companyId: companyId || null,
        location: sanitizeString(location, 200),
        linkedinUrl: sanitizeString(linkedinUrl, 500),
        profilePicture: sanitizeString(profilePicture, 500),
        email: sanitizeString(email, 200),
        phone: sanitizeString(phone, 50),
        about: sanitizeString(about, 2000),
        leadSource: leadSource || 'portal', // 'portal', 'extension', 'import', etc.
        savedAt: new Date(),
        createdAt: new Date()
      };

      const result = await leads.insertOne(newLead);
      
      // Increment usage
      await users.updateOne(
        { _id: req.user._id },
        { $inc: { 'usage.leadsScraped': 1 } }
      );

      res.json({ 
        success: true, 
        lead: { ...newLead, _id: result.insertedId }
      });

    } catch (error) {
      console.error('Save lead error:', error);
      res.status(500).json({ success: false, error: 'Failed to save lead' });
    }
  });

  // ========================================================================
  // DELETE /api/portal/leads/:id - Delete a lead (PORTAL ONLY)
  // ========================================================================
  app.delete('/api/portal/leads/:id', authMiddleware(users), async (req, res) => {
    try {
      const { ObjectId } = require('mongodb');
      const result = await leads.deleteOne({ 
        _id: new ObjectId(req.params.id),
        $or: [
          { visitorId: req.user._id.toString() },
          { visitorId: req.user.email },
          { visitorEmail: req.user.email },
          { userId: req.user._id.toString() }
        ]
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({ success: false, error: 'Lead not found' });
      }

      res.json({ success: true });

    } catch (error) {
      console.error('Delete lead error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete lead' });
    }
  });

  // ========================================================================
  // DELETE /api/user/delete-account - Delete user account
  // ========================================================================
  app.delete('/api/user/delete-account', authMiddleware(users), async (req, res) => {
    try {
      const userId = req.user._id;
      const userEmail = req.user.email;

      // Delete user's leads (using visitorId/visitorEmail/userId to match existing schema)
      await leads.deleteMany({ 
        $or: [
          { visitorId: userId.toString() },
          { visitorId: userEmail },
          { visitorEmail: userEmail },
          { userId: userId.toString() }
        ]
      });

      // Delete user (but NOT company - as per requirement)
      await users.deleteOne({ _id: userId });

      // Delete any OTPs
      await otpCodes.deleteMany({ email: userEmail });

      console.log(`🗑️ Account deleted: ${userEmail}`);

      res.json({ success: true, message: 'Account deleted successfully' });

    } catch (error) {
      console.error('Delete account error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete account' });
    }
  });

  console.log('✅ Portal Auth routes registered (ADDITIVE - existing routes unchanged)');
  console.log('   Auth endpoints: /api/auth/send-otp, /api/auth/verify-otp, /api/auth/verify-otp-only');
  console.log('   Auth endpoints: /api/auth/signup, /api/auth/login, /api/auth/google');
  console.log('   User endpoints: /api/user/profile, /api/user/features, /api/user/onboarding');
  console.log('   Portal leads: /api/portal/leads (GET, POST, DELETE) - requires auth');
  console.log('   Account: /api/user/delete-account');
  console.log('   🔗 Auto-linking: Existing leads are automatically linked on signup');
  console.log(`   Feature gates: ${FEATURE_GATES_ENABLED ? 'ENABLED' : 'DISABLED (safe mode)'}`);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateToken(user) {
  return jwt.sign(
    { 
      userId: user._id.toString(),
      email: user.email,
      plan: user.plan || 'free',
      source: 'portal'
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// SECURITY: Verify Google OAuth token properly using Google's tokeninfo endpoint
// This validates the token signature and ensures it wasn't forged
async function verifyGoogleToken(token) {
  try {
    // Use Google's tokeninfo endpoint to verify the token
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
    
    if (!response.ok) {
      console.error('Google token verification failed:', response.status);
      return null;
    }
    
    const payload = await response.json();
    
    // Verify the token was issued for our app (if GOOGLE_CLIENT_ID is set)
    const expectedClientId = process.env.GOOGLE_CLIENT_ID;
    if (expectedClientId && payload.aud !== expectedClientId) {
      console.error('Google token audience mismatch');
      return null;
    }
    
    // Verify token is not expired
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      console.error('Google token expired');
      return null;
    }
    
    return {
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      googleId: payload.sub,
      emailVerified: payload.email_verified === 'true'
    };
  } catch (error) {
    console.error('Google token verification error:', error);
    return null;
  }
}

// DEPRECATED: Keep for reference but don't use - tokens should be verified, not just decoded
function decodeGoogleToken(token) {
  console.warn('⚠️ decodeGoogleToken is deprecated - use verifyGoogleToken instead');
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString();
    return JSON.parse(payload);
  } catch (error) {
    return null;
  }
}

async function findOrCreateUser(users, userData) {
  const { email, name, picture, googleId } = userData;

  let user = await users.findOne({ email });

  if (!user) {
    const newUser = {
      email,
      name: name || email.split('@')[0],
      picture: picture || null,
      googleId: googleId || null,
      plan: 'free',
      features: FREE_PLAN_FEATURES,
      usage: {
        leadsScraped: 0,
        emailsGenerated: 0,
        dmsGenerated: 0,
        notesGenerated: 0,
        crmExports: 0
      },
      onboarding: {
        completed: false
      },
      source: 'portal',
      createdAt: new Date(),
      lastLogin: new Date()
    };

    const result = await users.insertOne(newUser);
    user = { ...newUser, _id: result.insertedId };
    console.log(`👤 New portal user created: ${email}`);
  }

  return user;
}

function sanitizeUser(user) {
  if (!user) return null;
  
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    picture: user.picture,
    plan: user.plan || 'free',
    features: user.plan === 'pro' ? PRO_PLAN_FEATURES : FREE_PLAN_FEATURES,
    usage: user.usage || {},
    onboarding: user.onboarding || { completed: false },
    createdAt: user.createdAt,
    lastLogin: user.lastLogin
    // NOTE: Never include password!
  };
}

function sanitizeString(str, maxLength = 500) {
  if (!str) return '';
  return String(str)
    .replace(/<[^>]*>/g, '')
    .replace(/['"\\]/g, '')
    .trim()
    .substring(0, maxLength);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email || '');
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

function authMiddleware(users) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'No token provided' });
      }

      const token = authHeader.substring(7);
      const decoded = verifyToken(token);

      if (!decoded) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
      }

      const user = await users.findOne({ email: decoded.email });

      if (!user) {
        return res.status(401).json({ success: false, error: 'User not found' });
      }

      req.user = user;
      req.token = decoded;
      next();

    } catch (error) {
      res.status(401).json({ success: false, error: 'Authentication failed' });
    }
  };
}

function optionalAuthMiddleware(users) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        req.user = null;
        return next();
      }

      const token = authHeader.substring(7);
      const decoded = verifyToken(token);

      if (decoded) {
        const user = await users.findOne({ email: decoded.email });
        req.user = user;
        req.token = decoded;
      } else {
        req.user = null;
      }

      next();

    } catch (error) {
      req.user = null;
      next();
    }
  };
}

// ============================================================================
// FEATURE GATE HELPERS
// ============================================================================

function checkFeatureAccess(user, feature) {
  if (!FEATURE_GATES_ENABLED) return true;
  if (!user) return false;
  
  const features = user.plan === 'pro' ? PRO_PLAN_FEATURES : FREE_PLAN_FEATURES;
  return features[feature] === true;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  setupAuthRoutes,
  authMiddleware,
  optionalAuthMiddleware,
  verifyToken,
  generateToken,
  checkFeatureAccess,
  linkExistingLeadsToUser,  // Export for potential use elsewhere
  FEATURE_GATES_ENABLED,
  FREE_PLAN_FEATURES,
  PRO_PLAN_FEATURES
};