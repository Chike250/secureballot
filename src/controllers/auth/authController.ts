import { Request, Response, NextFunction } from 'express';
import { authService, auditService, mfaService } from '../../services';
import { ApiError } from '../../middleware/errorHandler';
import { AuditActionType } from '../../db/models/AuditLog';
import { logger } from '../../config/logger';
import { logError } from '../../utils/logger';

/**
 * Register a new voter
 * @route POST /api/v1/auth/register
 * @access Public
 */
export const register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const {
      nin,
      vin,
      phoneNumber,
      dateOfBirth,
      password,
      fullName,
      pollingUnitCode,
      state,
      gender,
      lga,
      ward,
    } = req.body;

    // Check if voter already exists
    const voterExists = await authService.checkVoterExists(nin, vin);
    if (voterExists) {
      const error = new ApiError(
        409,
        'Voter with this NIN or VIN already exists',
        'VOTER_EXISTS',
        undefined,
        true,
      );
      throw error;
    }

    // Register new voter
    const voter = await authService.registerVoter({
      nin,
      vin,
      phoneNumber,
      dateOfBirth: new Date(dateOfBirth),
      password,
      fullName,
      pollingUnitCode,
      state,
      gender,
      lga,
      ward,
    });

    // Log the registration
    await auditService.createAuditLog(
      voter.id,
      AuditActionType.REGISTRATION,
      req.ip || '',
      req.headers['user-agent'] || '',
      { nin, phoneNumber },
    );

    res.status(201).json({
      success: true,
      message: 'Voter registered successfully',
      data: {
        id: voter.id,
        nin: voter.nin,
        vin: voter.vin,
        phoneNumber: voter.phoneNumber,
        fullName: voter.fullName,
        dateOfBirth: voter.dateOfBirth,
        pollingUnitCode: voter.pollingUnitCode,
        state: voter.state,
        lga: voter.lga,
        ward: voter.ward,
        gender: voter.gender,
        isActive: voter.isActive,
        mfaEnabled: voter.mfaEnabled,
        createdAt: voter.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Login a voter
 * @route POST /api/v1/auth/login
 * @access Public
 */
export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { identifier, password } = req.body;

    try {
      // Authenticate voter
      const voter = await authService.authenticateVoter(identifier, password);

      // Generate token
      const token = authService.generateToken(voter.id);

      // Log the login
      await auditService.createAuditLog(
        voter.id,
        AuditActionType.LOGIN,
        req.ip || '',
        req.headers['user-agent'] || '',
        { identifier, success: true },
      );

      res.status(200).json({
        success: true,
        message: 'Login successful',
        data: {
          token,
          voter: {
            id: voter.id,
            nin: voter.nin,
            vin: voter.vin,
            phoneNumber: voter.phoneNumber,
            fullName: voter.fullName,
            dateOfBirth: voter.dateOfBirth,
            pollingUnitCode: voter.pollingUnitCode,
            state: voter.state,
            lga: voter.lga,
            ward: voter.ward,
            gender: voter.gender,
            isActive: voter.isActive,
            lastLogin: voter.lastLogin,
            mfaEnabled: voter.mfaEnabled,
            createdAt: voter.createdAt,
          },
          requiresMfa: voter.requiresMfa,
        },
      });
    } catch (error) {
      // Log failed login attempt
      await auditService.createAuditLog(
        null, // Use null instead of 'unknown' for failed login attempts
        AuditActionType.LOGIN,
        req.ip || '',
        req.headers['user-agent'] || '',
        { identifier, success: false, error: (error as Error).message },
      );

      const apiError = new ApiError(
        401,
        'Invalid credentials',
        'INVALID_CREDENTIALS',
        undefined,
        true,
      );
      throw apiError;
    }
  } catch (error) {
    next(error);
  }
};

/**
 * Verify MFA token
 * @route POST /api/v1/auth/verify-mfa
 * @access Public
 */
export const verifyMfa = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { userId, token } = req.body;

    // Use mfaService to verify the token against the user's stored secret
    // Assuming mfaService.verifyMfaToken can handle non-admin verification based on userId
    const isValid = await mfaService.verifyMfaToken(userId, token);

    if (!isValid) {
      // Log failed MFA attempt before throwing
      await auditService.createAuditLog(
        userId,
        AuditActionType.MFA_VERIFY,
        req.ip || '',
        req.headers['user-agent'] || '',
        { success: false, error: 'Invalid MFA token' },
      );
      const error = new ApiError(401, 'Invalid MFA token', 'INVALID_MFA_TOKEN', undefined, true);
      throw error;
    }

    // Generate a new token with extended expiry
    // Assuming 'voter' role here, might need adjustment if admins can use this endpoint
    const newToken = authService.generateToken(userId, 'voter', '24h');

    // Log the MFA verification success
    await auditService.createAuditLog(
      userId,
      AuditActionType.MFA_VERIFY,
      req.ip || '',
      req.headers['user-agent'] || '',
      { success: true },
    );

    res.status(200).json({
      success: true,
      message: 'MFA verification successful',
      data: {
        token: newToken,
      },
    });
  } catch (error) {
    // Ensure failed attempts are logged even if other errors occur before the explicit log call
    let shouldLogFailure = true;
    // Check if the error is the specific ApiError for INVALID_MFA_TOKEN that we already logged
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'INVALID_MFA_TOKEN'
    ) {
      shouldLogFailure = false;
    }

    // Log failure if it wasn't the specific INVALID_MFA_TOKEN error and userId exists
    if (shouldLogFailure && req.body.userId) {
      // Safely get error message
      const errorMessage = error instanceof Error ? error.message : String(error);
      await auditService
        .createAuditLog(
          req.body.userId,
          AuditActionType.MFA_VERIFY,
          req.ip || '',
          req.headers['user-agent'] || '',
          { success: false, error: errorMessage },
        )
        .catch(error => logError('Failed to log MFA failure', error)); // Prevent logging error from masking original error
    }
    next(error);
  }
};

/**
 * Login an admin user
 * @route POST /api/v1/auth/admin-login
 * @access Public
 */
export const adminLogin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new ApiError(400, 'Email and password are required', 'MISSING_FIELDS');
    }

    try {
      // Authenticate admin
      const admin = await authService.authenticateAdmin(email, password);

      // Generate token with admin role
      const token = authService.generateToken(admin.id, 'admin');

      // Log the login
      await auditService.createAdminAuditLog(
        admin.id,
        AuditActionType.ADMIN_LOGIN,
        req.ip || '',
        req.headers['user-agent'] || '',
        { email, success: true },
      );

      res.status(200).json({
        success: true,
        message: 'Admin login successful',
        data: {
          token,
          user: {
            id: admin.id,
            email: admin.email,
            fullName: admin.fullName,
            role: admin.adminType,
          },
          requiresMfa: admin.mfaEnabled,
        },
      });
    } catch (error) {
      logger.info('Error:', { error });
      // Log failed login attempt
      await auditService.createAdminAuditLog(
        null,
        AuditActionType.ADMIN_LOGIN,
        req.ip || '',
        req.headers['user-agent'] || '',
        { email, success: false, error: (error as Error).message },
      );

      const apiError = new ApiError(
        401,
        'Invalid admin credentials',
        'INVALID_ADMIN_CREDENTIALS',
        undefined,
        true,
      );
      throw apiError;
    }
  } catch (error) {
    next(error);
  }
};

/**
 * Refresh token
 * @route POST /api/v1/auth/refresh-token
 * @access Private
 */
export const refreshToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // The user ID and role should be available from the authentication middleware
    const userId = (req as any).userId;
    const role = (req as any).role || 'voter';

    // Generate a new token with the same role
    const token = authService.generateToken(userId, role);

    // Log the token refresh
    await auditService.createAuditLog(
      userId,
      AuditActionType.TOKEN_REFRESH,
      req.ip || '',
      req.headers['user-agent'] || '',
      { success: true, role },
    );

    res.status(200).json({
      success: true,
      message: 'Token refreshed successfully',
      data: {
        token,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Logout a voter
 * @route POST /api/v1/auth/logout
 * @access Private
 */
export const logout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // The user ID should be available from the authentication middleware
    const userId = (req as any).user.id;

    // Logout the user
    await authService.logoutUser(userId);

    // Log the logout
    await auditService.createAuditLog(
      userId,
      AuditActionType.LOGOUT,
      req.ip || '',
      req.headers['user-agent'] || '',
      { success: true },
    );

    res.status(200).json({
      success: true,
      message: 'Logout successful',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Request password reset
 * @route POST /api/v1/auth/forgot-password
 * @access Public
 */
export const forgotPassword = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { email } = req.body;

    try {
      // Generate password reset token
      const result = await authService.generatePasswordResetToken(email);

      // In a real implementation, you would send an email with the token
      // For now, we'll just log it
      logger.debug(`Password reset token for ${email}: ${result.token}`);

      // Log the password reset request
      await auditService.createAuditLog(
        'system',
        AuditActionType.PASSWORD_RESET,
        req.ip || '',
        req.headers['user-agent'] || '',
        { email },
      );

      res.status(200).json({
        success: true,
        message: 'Password reset instructions sent to your email',
      });
    } catch (error) {
      // Don't reveal if the email exists or not
      res.status(200).json({
        success: true,
        message: 'If your email is registered, you will receive password reset instructions',
      });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * Reset password
 * @route POST /api/v1/auth/reset-password
 * @access Public
 */
export const resetPassword = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { token, newPassword } = req.body;

    try {
      // Reset the password
      await authService.resetPassword(token, newPassword);

      // Log the password reset
      await auditService.createAuditLog(
        'system',
        AuditActionType.PASSWORD_CHANGE,
        req.ip || '',
        req.headers['user-agent'] || '',
        { success: true },
      );

      res.status(200).json({
        success: true,
        message: 'Password reset successful',
      });
    } catch (error) {
      const apiError = new ApiError(
        400,
        'Invalid or expired token',
        'INVALID_RESET_TOKEN',
        undefined,
        true,
      );
      throw apiError;
    }
  } catch (error) {
    next(error);
  }
};
