// Riddles used by test/smoke.js (RIDDLES_FILE), so the test does not depend on server/riddles.js.
module.exports = {
  TEAMMATES: ['Zoya'],
  RIDDLES: [
    { title: 'The Secret Riddle One', text: 'Line one\nLine two', answer: 'Kiran', photo: 'README.md' }, // a file that exists in public/photos
    { title: 'The Team Vote', text: 'No answer set, the team decides', answer: '', photo: '' },
    { title: 'The Finale', text: 'What is it?', answer: 'Teamwork', choices: ['Coffee', 'Teamwork'], photo: 'nope.jpg' },
  ],
};
