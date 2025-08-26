const express = require("express");
const router = express.Router();

router.use("/", require("./auth"));
router.use("/", require("./calendar"));
router.use("/", require("./courses"));
router.use("/", require("./profile"));
router.use("/", require("./contentCourse"));
router.use("/", require("./videoLinks"));
router.use("/", require("./student"));
router.use("/", require("./quizzes"));
router.use("/", require("./foros"));

module.exports = router;

