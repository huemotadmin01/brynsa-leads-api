/**
 * Brynsa Authentication System
 * Designed for YOUR exact backend (index.js)
 * 
 * Features:
 * - Email-OTP authentication (MongoDB storage - survives restarts)
 * - Google OAuth (connects to extension's existing OAuth)
 * - JWT tokens (30-day expiry)
 * - Feature gates with usage tracking
 * - GET /api/user/features for extension to check plan
 * 
 * @version 2.0.0
 */

const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

// ============================================================================
// CONFIGURATION
// ============================================================================

const JWT_SECRET = process.env.JWT_SECRET || 'brynsa-dev-secret-change-in-production';
const JWT_EXPIRY = '30d';

// ============================================================================
// SETUP AUTH ROUTES
// ============================================================================

function setupAuthRoutes(app, db) {
  const users = db.collection('users');
  const otpCodes = db.collection('otp_codes');
  
  // Create TTL index for auto-expiring OTPs (MongoDB auto-deletes after expiry)
  otpCodes.createIndex({ "expiresAt": 1 }, { expireAfterSeconds: 0 }).catch(() => {});
  
  // Create indexes for users
  users.createIndex({ email: 1 }, { unique: true }).catch(() => {});
  users.createIndex({ googleId: 1 }, { sparse: true }).catch(() => {});

  // ==========================================================================
  // POST /api/auth/send-otp - Send OTP to email
  // ==========================================================================
  app.post('/api/auth/send-otp', async (req, res) => {
    try {
      const { email } = req.body;
      
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Valid email required' 
        });
      }

      const normalizedEmail = email.toLowerCase().trim();

      // Generate 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
      
      // Store in MongoDB (NOT in-memory - survives server restart)
      await otpCodes.updateOne(
        { email: normalizedEmail },
        { 
          $set: { 
            otp, 
            expiresAt,
            createdAt: new Date()
          } 
        },
        { upsert: true }
      );

      console.log(`📧 OTP for ${normalizedEmail}: ${otp}`);
      
      // TODO: In production, send via SendGrid/AWS SES
      // await sendEmail(normalizedEmail, `Your Brynsa OTP: ${otp}`);

      return res.json({
        success: true,
        message: 'OTP sent to email',
        // Debug only - REMOVE in production
        ...(process.env.NODE_ENV !== 'production' && { debug: { otp } })
      });

    } catch (error) {
      console.error('❌ Send OTP error:', error);
      res.status(500).json({ success: false, error: 'Failed to send OTP' });
    }
  });

  // ==========================================================================
  // POST /api/auth/verify-otp - Verify OTP and return JWT
  // ==========================================================================
  app.post('/api/auth/verify-otp', async (req, res) => {
    try {
      const { email, otp } = req.body;

      if (!email || !otp) {
        return res.status(400).json({ 
          success: false, 
          error: 'Email and OTP required' 
        });
      }

      const normalizedEmail = email.toLowerCase().trim();

      // Find OTP in MongoDB
      const otpRecord = await otpCodes.findOne({ email: normalizedEmail });
      
      if (!otpRecord) {
        return res.status(401).json({ 
          success: false, 
          error: 'No OTP found. Please request a new one.' 
        });
      }

      if (otpRecord.otp !== otp) {
        return res.status(401).json({ 
          success: false, 
          error: 'Invalid OTP' 
        });
      }

      if (new Date() > otpRecord.expiresAt) {
        await otpCodes.deleteOne({ email: normalizedEmail });
        return res.status(401).json({ 
          success: false, 
          error: 'OTP expired. Please request a new one.' 
        });
      }

      // OTP verified - find or create user
      const user = await findOrCreateUser(users, { email: normalizedEmail });

      // Generate JWT
      const token = generateToken(user);

      // Delete used OTP
      await otpCodes.deleteOne({ email: normalizedEmail });

      console.log(`✅ User logged in via OTP: ${normalizedEmail}`);

      return res.json({
        success: true,
        accessToken: token,
        user: sanitizeUser(user)
      });

    } catch (error) {
      console.error('❌ Verify OTP error:', error);
      res.status(500).json({ success: false, error: 'Verification failed' });
    }
  });

  // ==========================================================================
  // POST /api/auth/google - Google OAuth (extension sends user info)
  // ==========================================================================
  app.post('/api/auth/google', async (req, res) => {
    try {
      const { email, name, picture, googleId } = req.body;

      if (!email) {
        return res.status(400).json({ 
          success: false, 
          error: 'Email required from Google OAuth' 
        });
      }

      const normalizedEmail = email.toLowerCase().trim();

      // Find or create user
      const user = await findOrCreateUser(users, { 
        email: normalizedEmail,
        name: name || email.split('@')[0],
        picture: picture || null,
        googleId: googleId || null
      });

      // Generate JWT
      const token = generateToken(user);

      console.log(`✅ User logged in via Google: ${normalizedEmail}`);

      return res.json({
        success: true,
        accessToken: token,
        user: sanitizeUser(user)
      });

    } catch (error) {
      console.error('❌ Google auth error:', error);
      res.status(500).json({ success: false, error: 'Google authentication failed' });
    }
  });

  // ==========================================================================
  // GET /api/user/features - Get user's plan and features
  // Extension uses this to show locked/unlocked buttons
  // ==========================================================================
  app.get('/api/user/features', authMiddleware, async (req, res) => {
    try {
      const user = await users.findOne({ _id: new ObjectId(req.userId) });
      
      if (!user) {
        return res.status(404).json({ 
          success: false, 
          error: 'User not found' 
        });
      }

      return res.json({
        success: true,
        plan: user.plan,
        features: user.features,
        usage: user.usage || {}
      });

    } catch (error) {
      console.error('❌ Get features error:', error);
      res.status(500).json({ success: false, error: 'Failed to get features' });
    }
  });

  // ==========================================================================
  // GET /api/user/profile - Get user's full profile
  // ==========================================================================
  app.get('/api/user/profile', authMiddleware, async (req, res) => {
    try {
      const user = await users.findOne({ _id: new ObjectId(req.userId) });
      
      if (!user) {
        return res.status(404).json({ 
          success: false, 
          error: 'User not found' 
        });
      }

      return res.json({
        success: true,
        user: sanitizeUser(user)
      });

    } catch (error) {
      console.error('❌ Get profile error:', error);
      res.status(500).json({ success: false, error: 'Failed to get profile' });
    }
  });

  console.log('✅ Auth routes registered: /api/auth/send-otp, /api/auth/verify-otp, /api/auth/google, /api/user/features, /api/user/profile');
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Find existing user or create new one with FREE plan
 */
async function findOrCreateUser(usersCollection, userData) {
  const { email, name, picture, googleId } = userData;
  
  let user = await usersCollection.findOne({ email });

  if (!user) {
    // Create new user with FREE plan - all premium features LOCKED
    const newUser = {
      email,
      name: name || email.split('@')[0],
      picture: picture || null,
      googleId: googleId || null,
      plan: 'free',
      features: {
        emailGeneration: false,    // Premium - locked
        dmGeneration: false,       // Premium - locked
        noteGeneration: false,     // Premium - locked
        crmExport: false           // Premium - locked
      },
      subscription: {
        status: null,
        tier: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        currentPeriodEnd: null
      },
      usage: {
        emailsGenerated: 0,
        dmsGenerated: 0,
        notesGenerated: 0,
        crmExports: 0,
        leadsScraped: 0
      },
      createdAt: new Date(),
      lastLogin: new Date(),
      isActive: true
    };

    const result = await usersCollection.insertOne(newUser);
    user = { _id: result.insertedId, ...newUser };
    
    console.log(`✅ New user created: ${email} (plan: free)`);
  } else {
    // Update existing user
    const updateData = { lastLogin: new Date() };
    if (googleId && !user.googleId) updateData.googleId = googleId;
    if (picture && !user.picture) updateData.picture = picture;
    if (name && !user.name) updateData.name = name;
    
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: updateData }
    );
    
    // Refresh user data
    user = await usersCollection.findOne({ _id: user._id });
  }

  return user;
}

/**
 * Generate JWT token
 */
function generateToken(user) {
  return jwt.sign(
    {
      userId: user._id.toString(),
      email: user.email,
      plan: user.plan
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Remove sensitive fields from user object
 */
function sanitizeUser(user) {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    picture: user.picture,
    plan: user.plan,
    features: user.features,
    usage: user.usage
  };
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

/**
 * Authentication middleware - verifies JWT token
 * Adds req.userId for downstream handlers
 */
function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'No token provided',
        code: 'NO_TOKEN'
      });
    }

    const token = authHeader.substring(7);
    const decoded = verifyToken(token);
    
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    req.userPlan = decoded.plan;
    
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        success: false, 
        error: 'Token expired. Please login again.',
        code: 'TOKEN_EXPIRED'
      });
    }
    return res.status(401).json({ 
      success: false, 
      error: 'Invalid token',
      code: 'INVALID_TOKEN'
    });
  }
}

/**
 * Optional auth middleware - extracts user if token present, continues otherwise
 * Use for endpoints that work for both logged-in and anonymous users
 */
function optionalAuthMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const decoded = verifyToken(token);
      req.userId = decoded.userId;
      req.userEmail = decoded.email;
      req.userPlan = decoded.plan;
    }
    
    next();
  } catch (error) {
    // Token invalid - continue without auth
    next();
  }
}

/**
 * Check if user has specific feature enabled
 * Returns { allowed: boolean, user: object }
 */
async function checkFeatureAccess(db, userId, featureName) {
  const users = db.collection('users');
  const user = await users.findOne({ _id: new ObjectId(userId) });
  
  if (!user) {
    return { allowed: false, reason: 'User not found', user: null };
  }
  
  if (!user.features || !user.features[featureName]) {
    return { allowed: false, reason: 'Feature locked', user };
  }
  
  return { allowed: true, user };
}

/**
 * Increment usage counter for analytics
 */
async function incrementUsage(db, userId, featureName) {
  const usageField = {
    emailGeneration: 'usage.emailsGenerated',
    dmGeneration: 'usage.dmsGenerated',
    noteGeneration: 'usage.notesGenerated',
    crmExport: 'usage.crmExports',
    leadsScraping: 'usage.leadsScraped'
  };

  const field = usageField[featureName];
  if (field && userId) {
    try {
      await db.collection('users').updateOne(
        { _id: new ObjectId(userId) },
        { $inc: { [field]: 1 } }
      );
    } catch (e) {
      console.warn('Usage increment failed:', e.message);
    }
  }
}

/**
 * Feature names for display
 */
function getFeatureDisplayName(featureName) {
  const names = {
    emailGeneration: 'Email Generation',
    dmGeneration: 'LinkedIn DM Generation',
    noteGeneration: 'Connection Note Generation',
    crmExport: 'CRM Export'
  };
  return names[featureName] || featureName;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  setupAuthRoutes,
  authMiddleware,
  optionalAuthMiddleware,
  checkFeatureAccess,
  incrementUsage,
  verifyToken,
  getFeatureDisplayName
};
