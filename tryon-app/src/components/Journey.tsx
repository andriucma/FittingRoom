import { Icon } from "./Icon";

export function Journey({ current }: { current: 1 | 2 | 3 }) {
  return <ol className="journey" aria-label="Your fitting progress">
    {["Capture your turn", "Build your outfit", "See your look"].map((title, i) => <li key={title} className={i + 1 === current ? "is-current" : i + 1 < current ? "is-complete" : ""} aria-current={i + 1 === current ? "step" : undefined}>
      <span className="journey-number">{i + 1 < current ? <Icon name="check" width="14" height="14" /> : `0${i + 1}`}</span><span>{title}</span>
    </li>)}
  </ol>;
}
