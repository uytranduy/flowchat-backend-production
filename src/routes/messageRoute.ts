import express, { Router } from "express";
import {
  forwardMessage,
  recallMessage,
  removeMessageReaction,
  sendDirectMessage,
  sendGroupMessage,
  updateMessageReaction,
} from "../controllers/messageController.js";
import {
  checkGroupMembership,
} from "../middlewares/friendMiddleware.js";
import { uploadMessageFile } from "../middlewares/uploadMiddleware.js";

const router: Router = express.Router();

router.post("/direct", uploadMessageFile, sendDirectMessage);
router.post("/group", uploadMessageFile, checkGroupMembership, sendGroupMessage);
router.patch("/:messageId/recall", recallMessage);
router.put("/:messageId/reaction", updateMessageReaction);
router.delete("/:messageId/reaction", removeMessageReaction);
router.post("/:messageId/forward", forwardMessage);

export default router;
