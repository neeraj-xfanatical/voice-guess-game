// "Guess the Teammate" riddles.
//
// HOW TO SET UP
// 1. For each riddle, write the teammate's name in `answer` (as players should see it on the buttons).
// 2. Put that teammate's photo in public/photos/ and write the file name in `photo`
//    (jpg, png or webp; a square photo looks best). No photo? Leave it '' and their initials are shown.
// 3. Restart the server.
//
// Leave `answer` empty for a TEAM VOTE: everyone votes, the most-voted name is the team's
// pick and is revealed with the photo; everyone who voted with the team scores points.
// Fill in `answer` to make it a quiz instead: only the right answer scores.
// The choices for a riddle are every name in TEAMMATES plus every riddle answer, unless the
// riddle has its own `choices` list. The answer and photo are only sent at the reveal.

// The names players vote for.
const TEAMMATES = [
  'Neeraj',
  'Dhruv',
  'Kashish',
  'Seema',
  'Jigar',
  'Jason',
  'Sushmita',
  'Anurag',
  'Shruti',
  'Aman',
  'Ayesha',
  'Kaushik',
  'Vishal',
  'Sindhuja',
  'Harsh',
  'Monika',
  'William',
  'Kaleeswaran Senthur Pandian',
  'Harsha',
  'Pushpraj',
  'Team',
];

const RIDDLES = [
  {
    title: 'The Jugaad Master',
    text: "When problems arise, I don't lose my way,\nI find a shortcut and save the day.\nNo matter how tricky the task may be,\nA little jugaad is the key with me.\nWho am I?",
    answer: '',
    photo: 'jugad_master.png',
  },
  {
    title: 'The Speed Champion',
    text: "Why wait for tomorrow when I can finish today?\nGive me a task, and I'll find my way.\nQuick hands, quick mind, and work done fast,\nGuess who gets things done in a blast?",
    answer: '',
    photo: 'speed_cham.png',
  },
  {
    title: 'The Silent Genius',
    text: "I don't make noise, I don't need a show,\nBut somehow I get things done wherever I go.\nCalm and clever, with brains in action,\nWho is the master of silent execution?",
    answer: '',
    photo: 'silent_genius.png',
  },
  {
  title: 'The Perfectionist',
  text: 'Nothing escapes my watchful eye,\nI polish every task until it shines.\nGood is never quite enough for me,\nWho makes perfection the standard to be?',
  answer: '',
  photo: 'the-perfection.png',
},
 
  {
    title: 'The Walking Encyclopedia',
    text: "Need an answer? Just ask me why,\nI've got knowledge that could fill the sky.\nLike a book with every page in sight,\nWho makes learning feel effortless and bright?",
    answer: '',
    photo: 'the_knowledge.png',
  },
  {
  title: 'The Ganga of Knowledge',
  text: "From big-picture vision to the tiniest detail,\nHis knowledge and guidance never fail.\nFounder by role, mentor at the core,\nAsk him one thing—you'll learn ten things more!\nWho am I?",
  answer: '',
  photo: 'the_ganga.png',
  },

  {
  title: 'The marketing genius',
  text: "From brand new ideas to campaigns that fly,\nHe knows how to make a message reach the sky.\nDocuments, strategy, and marketing flair,\nA co-founder with ideas beyond compare!\nWho am I?",
  answer: '',
  photo: 'marketing_genius.gif',
},
{
  title: 'The Bridge Builder',
  text: "From marketing dreams to developer streams,\nShe turns big ideas into working schemes.\nShe connects two worlds that don't always agree,\nThe bridge between what we want and what we build—who could she be?",
  answer: '',
  photo: 'market_bridge.png',
},
  {
    title: 'The Technical Research Backbone',
    text: "Behind the docs and research, I play my part,\nTechnical writing is my craft and art.\nThe TME team's backbone, steady and strong,\nWho keeps technical knowledge flowing along?",
    answer: '',
    photo: 'tme_star.png',
  },
  {
    title: 'The Digital Marketing Saint',
    text: 'I work in digital, but keep my cool,\nNo chaos, no drama—just a peaceful rule.\nA marketer with a saint-like vibe,\nWho keeps calm while the campaigns thrive?',
    answer: '',
    photo: 'digital_marketing_saint.png',
  },
  {
  title: 'The Always-Available Helper',
  text: "Got a bug, a question, or a problem to solve,\nShe’s always around, ready to get involved.\nSafe Doc master, calm and clever,\nShe finds a solution to almost anything, whenever!\nWho is she?",
  answer: '',
  photo: 'safe-doc-master.png',
},
  {
  title: 'The Creative Designer',
  text: "She turns ideas into something bright,\nMaking every product feel just right.\nFrom user needs to a creative plan,\nGuess who makes the product shine again?",
  answer: '',
  photo: 'creative_designer.png',
},
  {
  title: 'The "Hello Guys!" Guy',
  text: "“Hello guys!” — that's how his videos begin,\nAn engineer with knowledge packed within.\nHe knows the code, the mind, and how to explain,\nTurning complex concepts into lessons that remain!\nWho is he?",
  answer: '',
  photo: 'hello_guys.png',
},
  {
    title: 'The Engineer & Cat Lover',
    text: "I debug code and love a cat,\nNow tell me, what's better than that?\nEngineering by day, feline love all the way,\nWho brings both worlds into play?",
    answer: '',
    photo: 'cat_debugger.png',
  },
  {
    title: 'The Designer with a Cat Obsession',
    text: 'Designs on screen and cats by my side,\nCreativity and cat love are my pride.\nGive me a canvas, give me a meow,\nWho is the creative cat lover now?',
    answer: '',
    photo: 'designer_cat.png',
  },
  {
    title: 'The Detailed Reporter',
    text: 'Every task has a story to tell,\nI keep you updated and track it well.\nNo missing details, no mystery left,\nWho gives updates with nothing skipped?',
    answer: '',
    photo: 'task_update.png',
  },
  {
  title: 'The Bangalore Queen',
  text: "Cool as Bangalore, stylish by nature,\nDigital campaigns are her signature feature.\nTrends and targets? She handles with ease,\nA queen with charm and marketing expertise!\nWho is she?",
  answer: '',
  photo: 'banglore-queen.png',
},
  {
  title: 'The Bridge Between Marketing & Development',
  text: "Between marketing ideas and technical plans,\nShe brings people together and understands.\nWith a constant smile, no matter what comes her way,\n“Leave it to me” makes worries fade away.\nWho keeps both teams connected every day?",
  answer: '',
  photo: 'tech-manager.png',
},
{
  title: 'The Travel & Celebration Queen',
  hard: true,
  text: "New destinations are always on her mind,\nThe perfect plan is never hard to find.\nFrom birthday gifts to trips away,\nShe makes every occasion a special day.\nWho is she?",
  answer: '',
  photo: 'hr.png',
},
{
  title: 'The Andhra Style Icon',
  text: "A little swag, a stylish stride,\nAnd Andhra pride he wears with pride.\nNo grand announcement, no need to explain,\nOne look says, “Anna has entered the game!”\nWho is he?",
  answer: '',
  photo: 'andhra-anna.png',
},

  {
    // The finale: not one person, so it has its own choices. Team photo: team.png.
    title: 'The Team Puzzle',
    hard: true,
    text: 'Some bring speed, some bring skill,\nSome bring knowledge, some bring will.\nSome test, some build, some design the view,\nBut what makes this team work as one crew?',
    answer: 'Teamwork',
    choices: ['Teamwork', 'Free pizza', 'Coffee', 'The Wi-Fi', 'Deadlines'],
    photo: 'team.png',
  },
];

module.exports = { TEAMMATES, RIDDLES };
