import express, { Router } from "express";
import {
  authMe,
  searchUserByUsername,
  uploadAvatar,
  changePassword,
  getPublicUser,
  updatePreferences,
  updateProfile,
} from "../controllers/userController.js";
import {
  blockUser,
  getBlockedUsers,
  getBlockStatus,
  unblockUser,
} from "../controllers/blockController.js";
import { upload } from "../middlewares/uploadMiddleware.js";

const router: Router = express.Router();

router.get("/me", authMe);
router.patch("/me", updateProfile);
router.patch("/me/preferences", updatePreferences);
router.patch("/me/password", changePassword);
router.get("/search", searchUserByUsername);
router.get("/:userId/public", getPublicUser);
router.post("/uploadAvatar", upload.single("file"), uploadAvatar);
router.get("/blocks", getBlockedUsers);
router.get("/blocks/:userId/status", getBlockStatus);
router.post("/blocks/:userId", blockUser);
router.delete("/blocks/:userId", unblockUser);

export default router;
