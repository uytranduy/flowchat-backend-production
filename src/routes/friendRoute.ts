import express, { Router } from "express";
import {
  acceptFriendRequest,
  sendFriendRequest,
  declineFriendRequest,
  getAllFriends,
  getFriendRequests,
  getFriendRelationship,
} from "../controllers/friendController.js";

const router: Router = express.Router();

router.post("/requests", sendFriendRequest);
router.post("/requests/:requestId/accept", acceptFriendRequest);
router.post("/requests/:requestId/decline", declineFriendRequest);
router.get("/", getAllFriends);
router.get("/requests", getFriendRequests);
router.get("/relationship/:userId", getFriendRelationship);

export default router;
