// ============================================================================
// auth.js - ADDITIVE Authentication Module for Brynsa Portal
// ============================================================================
// 
// SAFE ROLLOUT: This file ONLY ADDS new endpoints. It does NOT modify
// any existing routes or functionality. Your extension will continue
// to work exactly as before.
//
// New endpoints added:
// - POST /api/auth/send-otp
// - POST /api/auth/verify-otp  
// - POST /api/auth/google (for portal, separate from extension OAuth)
// - GET  /api/user/profile
// - PUT  /api/user/profile
// - GET  /api/user/features
// - POST /api/user/onboarding
//
// ============================================================================

const jwt = require('jsonwebtoken');

// ============================================================================
// CONFIGURATION
// ============================================================================

const JWT_SECRET = process.env.JWT_SECRET || 'brynsa-dev-secret-change-in-production';
const JWT_EXPIRY = '30d';
const OTP_EXPIRY_MINUTES = 10;

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
// SETUP AUTH ROUTES (ADDITIVE - doesn't modify existing routes)
// ============================================================================

function setupAuthRoutes(app, db) {
  const users = db.collection('portal_users'); // NEW collection - won't conflict
  const otpCodes = db.collection('otp_codes');

  // Create indexes
  users.createIndex({ email: 1 }, { unique: true }).catch(() => {});
  users.createIndex({ googleId: 1 }, { sparse: true }).catch(() => {});
  otpCodes.createIndex({ email: 1 }).catch(() => {});
  otpCodes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});

  // ========================================================================
  // POST /api/auth/send-otp - Send OTP to email
  // ========================================================================
  app.post('/api/auth/send-otp', async (req, res) => {
    try {
      const { email } = req.body;

      if (!email || !isValidEmail(email)) {
        return res.status(400).json({ success: false, error: 'Valid email is required' });
      }

      const normalizedEmail = email.toLowerCase().trim();
      const otp = generateOTP();
      const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

      await otpCodes.deleteMany({ email: normalizedEmail });
      await otpCodes.insertOne({
        email: normalizedEmail,
        otp,
        expiresAt,
        createdAt: new Date()
      });

      // TODO: Send actual email via SendGrid/AWS SES
      console.log(`📧 OTP for ${normalizedEmail}: ${otp}`);

      res.json({ 
        success: true, 
        message: 'OTP sent to email',
        // Remove in production - only for testing
        ...(process.env.NODE_ENV !== 'production' && { otp })
      });

    } catch (error) {
      console.error('❌ Send OTP error:', error);
      res.status(500).json({ success: false, error: 'Failed to send OTP' });
    }
  });

  // ========================================================================
  // POST /api/auth/verify-otp - Verify OTP and login/register
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
  // POST /api/auth/google - Google OAuth login (FOR PORTAL ONLY)
  // This is SEPARATE from extension's Google OAuth - they can coexist
  // ========================================================================
  app.post('/api/auth/google', async (req, res) => {
    try {
      const { credential } = req.body;

      if (!credential) {
        return res.status(400).json({ success: false, error: 'Google credential is required' });
      }

      const decoded = decodeGoogleToken(credential);

      if (!decoded || !decoded.email) {
        return res.status(401).json({ success: false, error: 'Invalid Google credential' });
      }

      const user = await findOrCreateUser(users, {
        email: decoded.email.toLowerCase(),
        name: decoded.name,
        picture: decoded.picture,
        googleId: decoded.sub
      });

      if (!user.googleId && decoded.sub) {
        await users.updateOne(
          { _id: user._id },
          { 
            $set: { 
              googleId: decoded.sub,
              picture: decoded.picture || user.picture,
              lastLogin: new Date()
            } 
          }
        );
      }

      const token = generateToken(user);

      res.json({
        success: true,
        token,
        user: sanitizeUser(user)
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

      await users.updateOne(
        { _id: req.user._id },
        {
          $set: {
            onboarding: {
              completed: true,
              companyName: sanitizeString(companyName, 200),
              role: sanitizeString(role, 100),
              teamSize: sanitizeString(teamSize, 50),
              useCase: sanitizeString(useCase, 100),
              completedAt: new Date()
            }
          }
        }
      );

      res.json({ success: true, message: 'Onboarding completed' });

    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to save onboarding' });
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

  console.log('✅ Portal Auth routes registered (ADDITIVE - existing routes unchanged)');
  console.log('   New endpoints: /api/auth/send-otp, /api/auth/verify-otp, /api/auth/google');
  console.log('   New endpoints: /api/user/profile, /api/user/features, /api/user/onboarding');
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
      source: 'portal' // Distinguish from extension auth
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

function decodeGoogleToken(token) {
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
      source: 'portal', // Track that user came from portal
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

// Optional auth - doesn't block, just adds user if token present
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
// FEATURE GATE HELPERS (for future use)
// ============================================================================

function checkFeatureAccess(user, feature) {
  // If gates disabled, allow everything (safe rollout)
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
  FEATURE_GATES_ENABLED,
  FREE_PLAN_FEATURES,
  PRO_PLAN_FEATURES
};