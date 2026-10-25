// Halloween dressing: a few bats, ghosts and pumpkins drifting in the page
// margins, painted BEHIND the content (negative z-index) so they can never cover
// a timer or a button. Pure CSS animation, no fetches; still on reduced motion.
const SPOOKS: { icon: string; pos: string; size: string; dur: number; delay: number; dx: number }[] = [
  { icon: "🦇", pos: "top-16 left-[4%]", size: "text-3xl", dur: 8, delay: 0, dx: 30 },
  { icon: "🦇", pos: "top-40 right-[6%]", size: "text-2xl", dur: 10, delay: 1.5, dx: -26 },
  { icon: "👻", pos: "top-[45%] left-[2%]", size: "text-4xl", dur: 12, delay: 0.8, dx: 18 },
  { icon: "🕸️", pos: "top-2 right-2", size: "text-5xl", dur: 14, delay: 0, dx: 0 },
  { icon: "🎃", pos: "bottom-14 left-[5%]", size: "text-4xl", dur: 9, delay: 2, dx: 10 },
  { icon: "🦇", pos: "bottom-1/3 right-[3%]", size: "text-3xl", dur: 11, delay: 3, dx: -32 },
  { icon: "🎃", pos: "bottom-10 right-[8%]", size: "text-3xl", dur: 10, delay: 0.4, dx: -12 },
];

export function HalloweenDecor() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden select-none">
      {SPOOKS.map((s, i) => (
        <span
          key={i}
          className={`cw-drift absolute opacity-40 ${s.pos} ${s.size}`}
          style={{
            ["--cw-dur" as string]: `${s.dur}s`,
            ["--cw-delay" as string]: `${s.delay}s`,
            ["--cw-dx" as string]: `${s.dx}px`,
            ["--cw-rot" as string]: `${i % 2 === 0 ? -8 : 8}deg`,
          }}
        >
          {s.icon}
        </span>
      ))}
    </div>
  );
}
