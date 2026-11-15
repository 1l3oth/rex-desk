// The sentences Voice mode says often. The server makes their sound as Voice mode opens and keeps it, so they play at once:
// the online voice takes 2 to 4 seconds to make any new sentence, which is too slow for a welcome or an "I'm on it".
// Shared by the page (what it says) and the server (what it prepares), so the text is exactly the same.
export const welcomeLine = (hour = new Date().getHours()) => `${hour < 5 ? 'Hey' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}! I'm here. What's on your mind?`;
export const STILL_THERE = "Are you still there? I'm listening.";
export const GOODBYE = "I'll be here when you need me.";
// What Voice mode says while the agent works instead of talking (chat-speak.js toolWords).
export const STEP_LINES = {
  files: 'Let me look at the files.', command: 'Running a command.', change: 'Making the change now.', web: 'Searching the web.',
  page: 'Reading a web page.', helper: 'Working on it.', agents: 'Checking on the agents.', notes: 'Checking my notes.',
  browser: 'Looking at it in the browser.', other: 'One moment, I am working on it.',
};
// Said by the agent itself often enough to be worth preparing.
export const AGENT_LINES = ["Sure, I'm on it.", 'Let me check that for you.'];
export const readyLines = (hour = new Date().getHours()) => [welcomeLine(hour), STILL_THERE, GOODBYE, ...AGENT_LINES, ...Object.values(STEP_LINES)];
