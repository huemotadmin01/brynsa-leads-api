// ============================================================================
// validation.js - Centralized Lead Validation for Brynsa Backend
// ============================================================================
// 
// This module provides validation functions to ensure data quality
// before saving to MongoDB or Google Sheets.
//
// RULES:
// 1. Name cannot be blank/empty
// 2. Name cannot contain digits
// 3. CompanyName cannot be blank/empty
// ============================================================================

/**
 * Validates a lead's name field
 * @param {string} name - The name to validate
 * @returns {object} { valid: boolean, error: string|null }
 */
function validateName(name) {
    // Check if name exists and is not empty
    if (!name || typeof name !== 'string') {
      return { valid: false, error: 'Name is required' };
    }
  
    const trimmedName = name.trim();
  
    // Check if name is blank after trimming
    if (trimmedName.length === 0) {
      return { valid: false, error: 'Name cannot be blank' };
    }
  
    // Check if name is too short (at least 2 characters)
    if (trimmedName.length < 2) {
      return { valid: false, error: 'Name must be at least 2 characters' };
    }
  
    // Check if name contains any digits
    if (/\d/.test(trimmedName)) {
      return { valid: false, error: 'Name cannot contain digits' };
    }
  
    // Check for suspicious patterns (optional - can be customized)
    const suspiciousPatterns = [
      /^test$/i,
      /^demo$/i,
      /^sample$/i,
      /^dummy$/i,
      /^fake$/i,
      /^n\/a$/i,
      /^na$/i,
      /^none$/i,
      /^null$/i,
      /^undefined$/i,
      /^unknown$/i,
      /^xxx+$/i,
      /^aaa+$/i,
    ];
  
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(trimmedName)) {
        return { valid: false, error: 'Name appears to be invalid or placeholder text' };
      }
    }
  
    return { valid: true, error: null };
  }
  
  /**
   * Validates a lead's company name field
   * @param {string} companyName - The company name to validate
   * @returns {object} { valid: boolean, error: string|null }
   */
  function validateCompanyName(companyName) {
    // Check if company name exists and is not empty
    if (!companyName || typeof companyName !== 'string') {
      return { valid: false, error: 'Company name is required' };
    }
  
    const trimmedCompany = companyName.trim();
  
    // Check if company name is blank after trimming
    if (trimmedCompany.length === 0) {
      return { valid: false, error: 'Company name cannot be blank' };
    }
  
    // Check if company name is too short (at least 2 characters)
    if (trimmedCompany.length < 2) {
      return { valid: false, error: 'Company name must be at least 2 characters' };
    }
  
    // Check for placeholder values
    const placeholderPatterns = [
      /^test$/i,
      /^demo$/i,
      /^sample$/i,
      /^dummy$/i,
      /^fake$/i,
      /^n\/a$/i,
      /^na$/i,
      /^none$/i,
      /^null$/i,
      /^undefined$/i,
      /^unknown$/i,
      /^xxx+$/i,
      /^aaa+$/i,
      /^company$/i,
      /^my company$/i,
      /^your company$/i,
    ];
  
    for (const pattern of placeholderPatterns) {
      if (pattern.test(trimmedCompany)) {
        return { valid: false, error: 'Company name appears to be invalid or placeholder text' };
      }
    }
  
    return { valid: true, error: null };
  }
  
  /**
   * Validates a complete lead object before saving
   * @param {object} lead - The lead object to validate
   * @param {object} options - Validation options
   * @param {boolean} options.requireCompany - Whether company is required (default: true)
   * @returns {object} { valid: boolean, errors: string[] }
   */
  function validateLead(lead, options = {}) {
    const { requireCompany = true } = options;
    const errors = [];
  
    // Validate name (always required)
    const nameValidation = validateName(lead.name);
    if (!nameValidation.valid) {
      errors.push(nameValidation.error);
    }
  
    // Validate company name (required by default)
    if (requireCompany) {
      // Check both 'companyName' and 'company' fields
      const companyValue = lead.companyName || lead.company;
      const companyValidation = validateCompanyName(companyValue);
      if (!companyValidation.valid) {
        errors.push(companyValidation.error);
      }
    }
  
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  /**
   * Middleware factory for Express routes
   * Returns middleware that validates lead data before proceeding
   * @param {object} options - Validation options
   * @returns {function} Express middleware
   */
  function validateLeadMiddleware(options = {}) {
    return (req, res, next) => {
      const validation = validateLead(req.body, options);
      
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          validationErrors: validation.errors,
          message: validation.errors.join('. ')
        });
      }
      
      next();
    };
  }
  
  // ============================================================================
  // EXPORTS
  // ============================================================================
  
  module.exports = {
    validateName,
    validateCompanyName,
    validateLead,
    validateLeadMiddleware
  };