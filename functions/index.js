// YKF cloud jobs (runs on Google's servers, groomer-ykf project).
// "✨ Create video with AI" on a procedure: voice + video maker (see procvideo.js).
const { initializeApp } = require('firebase-admin/app');
initializeApp();
exports.makeProcVideo = require('./procvideo').makeProcVideoFunction();
