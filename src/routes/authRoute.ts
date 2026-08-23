import express, { Router } from "express";
import {
  refreshToken,
  forgotPassword,
  resendVerificationEmail,
  resetPassword,
  signIn,
  signInWithGoogle,
  signOut,
  signUp,
  verifyEmail,
} from "../controllers/authController.js";

const router: Router = express.Router();

router.post("/signup", signUp);
router.post("/signin", signIn);
router.post("/google", signInWithGoogle);
router.post("/verify-email", verifyEmail);
router.post("/resend-verification", resendVerificationEmail);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/signout", signOut);
router.post("/refresh", refreshToken);

export default router;
