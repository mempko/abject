/**
 * Every screenshot and clip on the site, in one place.
 *
 * Images live in public/gallery/ (WebP), clips in public/media/ (MP4 H.264
 * plus WebM VP9, no audio, with a poster). A slot with `video` plays a
 * muted loop (a still `src` stands in under reduced motion and as the
 * poster). A slot without `src` renders a styled placeholder. Captures are
 * from a real desktop in the Red Sigil theme (Sept 2026); `retake: true`
 * marks a slot that still wants a better capture, and `want` says what.
 */
export interface ShotSlot {
  /** Image path under public/, or undefined while the shot is pending. */
  src?: string;
  /** Optional looping clip: mp4 and webm sources, poster defaults to src. */
  video?: { mp4: string; webm?: string; poster?: string };
  /** File name of the capture (under public/gallery/ or public/media/). */
  file: string;
  /** Title shown in the window bar of the frame. */
  title: string;
  alt: string;
  caption?: string;
  /** Width / height of the image, so the frame reserves space. */
  aspect: number;
  /** True while the slot still wants a better capture. */
  retake: boolean;
  /** What a (re)capture should show. */
  want: string;
}

const DESKTOP = 1947 / 999;

export const SHOTS = {
  hero: {
    src: '/gallery/desktop.webp',
    file: 'desktop.webp',
    title: 'The Horror · desktop',
    alt: 'The Abject desktop in the Red Sigil theme: a Wiki Tag Graph window drawing 474 notes and 14,615 links as clusters of colored circles, a Conversations window listing 31 chats, and a chat window working on a goal, beside the sidebar dock',
    caption: 'A real desktop, mid-goal: a graph of 474 notes and 14,615 links, the chat list, and a chat busy upgrading a fish tank. Nothing staged.',
    aspect: DESKTOP,
    retake: false,
    want: 'Full desktop in Red Sigil: Chat creating an abject, two or three live abjects, the dock with a lit busy row.',
  },
  tour: {
    src: '/media/desktop-tour-poster.jpg',
    video: { mp4: '/media/desktop-tour.mp4', webm: '/media/desktop-tour.webm', poster: '/media/desktop-tour-poster.jpg' },
    file: 'desktop-tour.mp4',
    title: 'Live capture',
    alt: 'A screen capture of a live Abject desktop, about a minute long: 3D Pong playing in its window beside a Hacker News reader, a Map Draw window opening and panning over Seattle, a 3D fish tank, an audio recorder, The Eye LLM monitor with its call history and map, the windows spreading into Expose, a weather window, and a mind map',
    caption: 'A minute on a live desktop: 3D Pong, a map you can draw on, a 3D fish tank, The Eye watching every model call, Expose, and a mind map.',
    aspect: 1600 / 802,
    retake: false,
    want: 'A short screen recording of the desktop in use.',
  },
  nasa: {
    src: '/gallery/nasa.webp',
    file: 'nasa.webp',
    title: 'NASA Live Viewer',
    alt: 'A NASA Live Viewer window showing live imagery of the Sun (SDO AIA 304) and the Earth (GOES-16 GeoColor) side by side, in front of a 3D fish tank, with a chat window working on a goal',
    caption: 'A NASA viewer streaming the Sun and the Earth, refreshing itself every minute, while a chat works on a goal beside it.',
    aspect: DESKTOP,
    retake: false,
    want: 'A live data abject.',
  },
  tasks: {
    src: '/gallery/tasks.webp',
    file: 'tasks.webp',
    title: 'Work · tasks',
    alt: 'The Work space in a green palette: a Getting Things Done task list with Inbox, Next Actions, Projects, Waiting For and Someday tabs, beside a Kanban board of the same tasks in To Do, In Progress and Done columns',
    caption: 'A task list and a Kanban board working from the same tasks. The Work space wears its own palette.',
    aspect: DESKTOP,
    retake: false,
    want: 'A productivity pair in a workspace with its own palette.',
  },
  breakout: {
    src: '/gallery/breakout.webp',
    file: 'breakout.webp',
    title: 'mempko · play',
    alt: 'A space in a cyan palette: a Breakout game with rows of colored bricks, beside a Top Stories window that reads seven news sources and writes a daily summary',
    caption: 'Breakout, and a front page that reads seven sources and writes its own daily summary. This space is cyan.',
    aspect: DESKTOP,
    retake: false,
    want: 'A game and a reader in a space with its own palette.',
  },
  mapdraw: {
    src: '/gallery/mapdraw.webp',
    file: 'mapdraw.webp',
    title: 'Map Draw',
    alt: 'A Map Draw window over OpenStreetMap showing Seattle with a marker and a drawn ferry route, beside a Lobsters reader listing the hottest stories',
    caption: 'A map you can draw on, over OpenStreetMap, saved per trip. The Lobsters reader behind it refreshes itself.',
    aspect: DESKTOP,
    retake: false,
    want: 'A drawing tool over a live map.',
  },
  recorder: {
    src: '/gallery/recorder.webp',
    file: 'recorder.webp',
    title: 'Audio Recorder',
    alt: 'An Audio Recorder window listing four recordings, the selected one transcribed as text, beside a Hacker News reader',
    caption: 'An audio recorder that writes down what it hears, next to a Hacker News reader.',
    aspect: DESKTOP,
    retake: false,
    want: 'A media abject.',
  },
  expose: {
    src: '/gallery/expose.webp',
    video: { mp4: '/media/expose-loop.mp4', webm: '/media/expose-loop.webm', poster: '/gallery/expose.webp' },
    file: 'expose.webp',
    title: 'Expose',
    alt: 'Expose: nine windows of the space spread into a labeled grid (a chat, Mindmaps, Silverdale weather, a 3D fish tank, a mind map, Hacker News, Map Draw, an audio recorder and The Eye), then the weather window picked and flown back',
    caption: 'F3 spreads every window of the space out to pick from; pick one and it flies back.',
    aspect: DESKTOP,
    retake: false,
    want: 'Desktop Expose with six to eight windows.',
  },
  scene3d: {
    src: '/gallery/pong.webp',
    video: { mp4: '/media/pong-loop.mp4', webm: '/media/pong-loop.webm', poster: '/gallery/pong.webp' },
    file: 'pong.webp',
    title: '3D Pong',
    alt: 'A 3D Pong window: a green paddle and a glowing ball over a neon grid court in perspective',
    caption: '3D Pong in its window: real meshes and lights, a neon court, a glowing ball. The window is a slab in the same scene.',
    aspect: 966 / 684,
    retake: false,
    want: 'A 3D abject in its window.',
  },
  materials: {
    src: '/gallery/materials.webp',
    file: 'materials.webp',
    title: 'Scene Showcase',
    alt: 'The Scene Showcase materials station: spheres in gold, chrome, copper, glass, ceramic and obsidian on a plinth under a studio look, and a capsule, a toon rounded box, a bone lathe, a neon star, a hologram torus and a brushed metal knot on the floor',
    caption: "One param each: material: 'gold', 'glass', 'neon'. The studio lighting is one more: look: 'studio'.",
    aspect: 857 / 680,
    retake: true,
    want: 'SceneShowcase materials station captured from the desktop app (this one is a headless render).',
  },
  maps: {
    src: '/gallery/agents-map.webp',
    file: 'agents-map.webp',
    title: 'Agents · Map',
    alt: 'The Agents window on its Map tab: agents and the goals they work on as a 3D graph of connected spheres, beside the list of agents and goals',
    caption: 'The Agents map: who works on what, as a graph you can turn.',
    aspect: 621 / 429,
    retake: false,
    want: 'A Map view with a few dozen linked nodes.',
  },
  fishtank: {
    src: '/gallery/fishtank.webp',
    video: { mp4: '/media/fishtank-loop.mp4', webm: '/media/fishtank-loop.webm', poster: '/gallery/fishtank.webp' },
    file: 'fishtank.webp',
    title: 'Fish Tank 3D',
    alt: 'A 3D fish tank: fish swimming through blue water above a sandy floor with pink coral, rocks and a treasure chest',
    caption: 'A 3D fish tank that keeps swimming whether or not anyone is watching.',
    aspect: 484 / 598,
    retake: false,
    want: 'A 3D abject in motion.',
  },
  mapdrawLive: {
    src: '/gallery/mapdraw-live.webp',
    video: { mp4: '/media/mapdraw-loop.mp4', webm: '/media/mapdraw-loop.webm', poster: '/gallery/mapdraw-live.webp' },
    file: 'mapdraw-live.webp',
    title: 'Map Draw',
    alt: 'The Map Draw window panning and zooming over an OpenStreetMap map of Seattle, with its drawing tools (Pan, Marker, Line, Polygon, Freehand) above the map',
    caption: 'Map Draw over OpenStreetMap: pan, zoom, and draw markers, lines and polygons on a trip.',
    aspect: 700 / 703,
    retake: false,
    want: 'A live map abject in motion.',
  },
  mindmap: {
    src: '/gallery/mindmap.webp',
    video: { mp4: '/media/mindmap-loop.mp4', webm: '/media/mindmap-loop.webm', poster: '/gallery/mindmap.webp' },
    file: 'mindmap.webp',
    title: 'The Universe Is Intelligent',
    alt: 'A mind map titled The Universe Is Intelligent: branches such as Yi Ma\'s Principles of Intelligence and The Open/Closed Problem in AI with their child notes, beside a description panel',
    caption: 'A mind map of 68 notes, grown from the keyboard and kept per map in a library.',
    aspect: 924 / 665,
    retake: false,
    want: 'A mind map abject.',
  },
  patternMap: {
    src: '/gallery/pattern-map.webp',
    file: 'pattern-map.webp',
    title: 'Pattern language',
    alt: 'A 3D map of learned patterns: spheres linked into clusters, labeled Mine Critique Edit in Place, Latch on First Event, Turnstile Needs a Human, Narrow Research Lanes, Dossier First Persist Second and others, with The Team, the Setup, the Verification selected in red',
    caption: 'Patterns link to each other, so a lesson arrives with its neighbours.',
    aspect: 623 / 869,
    retake: false,
    want: 'The pattern map.',
  },
  patternCard: {
    src: '/gallery/pattern-card.webp',
    file: 'pattern-card.webp',
    title: 'A learned pattern',
    alt: 'A pattern card titled The Team, the Setup, the Verification with Aliases, Context, Problem, Forces, Therefore, Evidence and Recorded evidence: revision 1, helpful in 33 distinct goals, counterexamples in 0 goals',
    caption: 'Written by the reviewer, not by hand: context, problem, forces, what to do, and the goals that proved it.',
    aspect: 623 / 869,
    retake: false,
    want: 'One pattern card open.',
  },
  patternList: {
    src: '/gallery/pattern-list.webp',
    file: 'pattern-list.webp',
    title: 'Learned patterns',
    alt: 'A list of learned patterns with usefulness counts: External Store of Truth (useful 24), Batch the Boring Part, Trust the Registry Not the Text, The Team the Setup the Verification (useful 20), Diagnose Before Repair (useful 15), Modify in Place Verify from Outside (useful 28) and more',
    aspect: 534 / 831,
    retake: false,
    want: 'The pattern list.',
  },
  tasksPair: {
    src: '/gallery/tasks-pair.webp',
    file: 'tasks-pair.webp',
    title: 'Tasks and Kanban',
    alt: 'Two windows in the Work space: a Getting Things Done task list (Inbox, Next Actions, Projects, Waiting For, Someday tabs, with Next, Someday and Done buttons on each task) and a Kanban board showing the same tasks in To Do, In Progress and Done columns, marked Connected (live)',
    caption: 'A Getting Things Done list and a Kanban board showing the same tasks, kept in sync.',
    aspect: 1726 / 860,
    retake: false,
    want: 'The task list and Kanban pair.',
  },
  wikigraph: {
    src: '/gallery/wikigraph.webp',
    file: 'wikigraph.webp',
    title: 'Wiki Tag Graph',
    alt: 'A Wiki Tag Graph window: 474 notes and 14,615 edges drawn as clusters of colored circles by tag, with a legend of the top tags',
    aspect: 1101 / 750,
    retake: false,
    want: 'The wiki graph.',
  },
  chat: {
    src: '/gallery/chat.webp',
    file: 'chat.webp',
    title: 'Chat · working',
    alt: 'A chat window working on a goal: the goal and its verification tasks listed with their status, and the request that started it',
    aspect: 810 / 897,
    retake: false,
    want: 'The Chat window mid-goal.',
  },
  // Tight crops of the captures above, for the Sightings collage (they read
  // at small sizes). Crop boxes are in the source capture's pixels.
  nasaViewer: {
    src: '/gallery/nasa-viewer.webp',
    file: 'nasa-viewer.webp',
    title: 'NASA Live Viewer',
    alt: 'The NASA Live Viewer window: live imagery of the Sun (NASA SDO AIA 304) and the Earth (NOAA GOES-16 GeoColor) side by side, with the 3D fish tank behind it',
    caption: 'A NASA viewer streaming the Sun and the Earth, refreshing itself every minute, in front of the fish tank.',
    aspect: 765 / 710,
    retake: false,
    want: 'Crop of nasa.webp (360,90)-(1125,800).',
  },
  breakoutSpace: {
    src: '/gallery/breakout-space.webp',
    file: 'breakout-space.webp',
    title: 'mempko · play',
    alt: 'A space in a cyan palette: the sidebar in cyan, a Breakout game with rows of colored bricks, and a Top Stories window that reads seven news sources and writes a daily summary',
    caption: 'Breakout, and a front page that reads seven sources and writes its own daily summary. This space is cyan.',
    aspect: 1720 / 999,
    retake: false,
    want: 'Crop of breakout.webp (0,0)-(1720,999).',
  },
  mapdrawWindow: {
    src: '/gallery/mapdraw-window.webp',
    file: 'mapdraw-window.webp',
    title: 'Map Draw',
    alt: 'The Map Draw window over OpenStreetMap: Seattle with a Home Base marker and a drawn Ferry Route, the drawing tools, and the saved maps list',
    caption: 'A map you can draw on, over OpenStreetMap: a marker, a ferry route, saved per trip.',
    aspect: 994 / 715,
    retake: false,
    want: 'Crop of mapdraw.webp (872,180)-(1866,895).',
  },
  recorderNews: {
    src: '/gallery/recorder-news.webp',
    file: 'recorder-news.webp',
    title: 'Audio Recorder',
    alt: 'An Audio Recorder window listing four recordings with the selected one transcribed as text, beside a Hacker News reader',
    caption: 'An audio recorder that writes down what it hears, next to a Hacker News reader.',
    aspect: 1380 / 730,
    retake: false,
    want: 'Crop of recorder.webp (165,40)-(1545,770).',
  },
  patterns: {
    src: '/gallery/knowledge.webp',
    file: 'knowledge.webp',
    title: 'Knowledge · Patterns',
    alt: 'The Knowledge window on its Patterns tab: a list of learned patterns (External Store of Truth, Batch the Boring Part, Trust the Registry Not the Text, Diagnose Before Repair, Modify in Place Verify from Outside and more, each with how many times it proved useful), a 3D map of the pattern language with linked patterns as spheres, and the pattern The Team, the Setup, the Verification open with its context, problem, forces, therefore and evidence',
    caption: 'The pattern language one desktop has learned: every pattern names a problem, the forces at play, what to do, and the evidence. This one proved helpful in 33 goals.',
    aspect: 1953 / 991,
    retake: false,
    want: 'The Knowledge window on its Patterns tab.',
  },
  phone: {
    file: 'phone.webp',
    title: 'Phone',
    alt: 'The phone showing the same desktop through a zoomable camera',
    aspect: 9 / 19.5,
    retake: true,
    want: 'Phone screenshot (portrait): the desktop view zoomed out, or focus mode on a window.',
  },
} satisfies Record<string, ShotSlot>;

export type ShotId = keyof typeof SHOTS;
