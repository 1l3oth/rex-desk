// The Settings tours: one short tour per feature, in the order a new person meets them. Each step points at a real
// control in Settings. km is shown and read aloud (Rex's own voice, from public/guides/voice/<id>.m4a); say, when
// given, is what the voice reads instead, for words it says better spelled another way; en is the English line.
// One idea per sentence, ending in ។ so the voice pauses. Common tech words stay in Latin letters.
// After changing a line, run scripts/make-tour-voice.js to voice it again.
export const INTRO = { id: 'intro', km: 'នេះគឺ Rex Desk។ ខ្ញុំនឹងបង្ហាញ Settings ម្តងមួយផ្នែក។', en: 'This is Rex Desk. I will show you Settings, one part at a time.' };
export const OUTRO = { id: 'outro', target: '.st-tip', km: 'ផ្នែកនីមួយៗមាន Best use នៅខាងលើ។ ចុច Show me ដើម្បីមើលម្តងទៀត។', en: 'Every section has a Best use note at the top. Press Show me to see its tour again.' };

export const TOURS = {
  general: [
    { km: 'General៖ ឈ្មោះរបស់អ្នក និងពណ៌ផ្ទៃ។', en: 'General: your name and the theme.' },
    { target: '[name="autostart"]', km: 'បើកមួយនេះ ដើម្បីឲ្យ Rex Desk បើកជាមួយ Windows។', en: 'Turn this on so Rex Desk starts with Windows, and schedules and your phone keep working.' },
  ],
  agents: [
    { km: 'Agents៖ របៀបដែលជំនួយការ AI របស់អ្នកធ្វើការ។', en: 'Agents: how your AI helpers work.' },
    { target: '[name="concurrency"]', km: 'ពីរ agent ក្នុងពេលតែមួយ ល្អសម្រាប់ចាប់ផ្តើម។', en: 'Two agents at once is a good start. More uses your Claude limit faster.' },
    { target: '[name="defaultMode"]', km: 'Auto ធ្វើជំហានដែលមានសុវត្ថិភាព។ ជំហានប្រថុយ វាសួរអ្នកមុន។', en: 'Auto runs safe steps on its own and asks you before risky ones.' },
    { target: '[name="saver"]', km: 'Save my Claude usage ជួយសន្សំ limit របស់អ្នក។', en: '"Save my Claude usage" keeps light chats on a cheaper model.' },
  ],
  accounts: [
    { km: 'Claude accounts៖ បន្ថែមគណនីទីពីរ តែពេលអ្នកអស់ limit ញឹកញាប់។', en: 'Claude accounts: add a second one only if you often hit the limit.' },
  ],
  schedule: [
    { km: 'Schedule៖ agent ចាប់ផ្តើមការងារដោយខ្លួនឯង តាមម៉ោងកំណត់។', en: 'Schedule: agents start work by themselves at a set time.' },
    { target: '[name="schedule.maxRuns"]', km: 'កំណត់ម៉ោងពេលព្រឹក ហើយដាក់ចំនួនតិចៗ។', en: 'Set it for the start of your day, with a small daily limit.' },
  ],
  signins: [
    { km: 'Test sign-ins៖ គណនីសាកល្បង ឲ្យ agent ពិនិត្យការកែរបស់វា។', say: 'Test sign in៖ គណនីសាកល្បង ឲ្យ agent ពិនិត្យការកែរបស់វា។', en: 'Test sign-ins: a test account agents use to check their fix on screen.' },
    { target: '[data-st-signin-add]', km: 'វា sign in ដោយមិនឃើញ password ឡើយ។', en: 'They sign in without ever seeing the password.' },
  ],
  projects: [
    { km: 'Projects៖ folder កូដ ដែល agent ធ្វើការលើ។', en: 'Projects: the code folders your agents work on.' },
    { target: '.st-repo, .st-add', km: 'កំណត់ branch ចាប់ផ្តើម និងកន្លែងផ្ញើ pull request។', en: 'Set where new work starts and where pull requests go. Commands are found for you.' },
  ],
  sources: [
    { km: 'Task sources៖ កន្លែងដែល task មកពី។', en: 'Task sources: where tasks come from.' },
    { target: '.st-tracker, [data-tr-add], .st-tip', km: 'Rex Desk មាន task ស្រាប់។ ភ្ជាប់ Flow ឬ Morningmate តែបើក្រុមអ្នកប្រើ។', en: 'Rex Desk tasks are built in. Connect Flow or Morningmate only if your team uses them.' },
  ],
  jev: [
    { km: 'Jev៖ បញ្ជាកុំព្យូទ័រនេះ ដោយការនិយាយ។', en: 'Jev: control this computer by talking.' },
    { target: '[name="control.confirm"]', km: 'ទុកមួយនេះឲ្យបើក កុំឲ្យបិទកុំព្យូទ័រដោយច្រឡំ។', en: 'Keep this on, so nothing big like a shutdown happens by mistake.' },
  ],
  notify: [
    { km: 'Notifications៖ ទុក pop-up សម្រាប់តែសំណួរ។ កំណត់ម៉ោងស្ងាត់ពេលយប់។', say: 'Notifications៖ ទុក pop up សម្រាប់តែសំណួរ។ កំណត់ម៉ោងស្ងាត់ពេលយប់។', en: 'Notifications: keep pop-ups for questions, and set quiet hours for the night.' },
  ],
  folders: [
    { km: 'Folders៖ កន្លែងទុកទិន្នន័យ និងឯកសាររបស់ agent។', en: 'Folders: where your data and the agents\' files are kept.' },
    { target: '.st-folder:last-child', km: 'ប្តូរ Files from agents ទៅ drive ធំ បើ C ពេញ។', en: 'Move "Files from agents" to a big drive if screenshots fill up C:.' },
  ],
  backup: [
    { km: 'Backup៖ sign in ជាមួយគណនី Rex Desk។ chat របស់អ្នកទៅតាមគ្រប់កុំព្យូទ័រ។', en: 'Backup: sign in with your Rex Desk account and your chats follow you to every computer.' },
  ],
  devices: [
    { km: 'Devices៖ scan QR code ម្តង ដើម្បីឆ្លើយ agent ពីទូរស័ព្ទ។', en: 'Devices: scan the QR code once to answer your agents from your phone.' },
  ],
  connect: [
    { km: 'Connect another AI៖ ឲ្យ Claude Code ដែលបើកស្រាប់ ឃើញ task របស់អ្នក។', en: 'Connect another AI: let a Claude Code window you already have see your tasks.' },
  ],
};
// Every step gets an id (section-number), which names its voice file.
for (const [section, steps] of Object.entries(TOURS)) steps.forEach((step, index) => { step.id = `${section}-${index + 1}`; });
export const ORDER = ['general', 'agents', 'accounts', 'schedule', 'signins', 'projects', 'sources', 'jev', 'notify', 'folders', 'backup', 'devices', 'connect'];
export const ALL_STEPS = [INTRO, ...ORDER.flatMap(section => TOURS[section]), OUTRO];
