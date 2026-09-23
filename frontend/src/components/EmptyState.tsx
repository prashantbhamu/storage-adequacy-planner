import { FlaskConical } from "lucide-react";
import { useEffect, useState } from "react";

const LOOP = "7s";
// Phase boundaries as fractions of the loop.
const T = { rest: 0.12, charged: 0.4, discharged: 0.68, hold: 0.9 };

const BEFORE = "M20 90 C70 90 80 28 130 28 C180 28 190 90 240 90 L320 90 C370 90 380 152 430 152 C480 152 490 90 540 90";
const CHARGED = "M20 90 C70 90 80 62 130 62 C180 62 190 90 240 90 L320 90 C370 90 380 152 430 152 C480 152 490 90 540 90";
const AFTER = "M20 90 C70 90 80 62 130 62 C180 62 190 90 240 90 L320 90 C370 90 380 118 430 118 C480 118 490 90 540 90";
const TO_STORAGE = "M130 40 Q205 16 280 70";
const TO_DEFICIT = "M280 112 Q360 150 430 128";

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

const times = (...values: number[]) => values.map((value) => value.toFixed(3)).join(";");

/** One energy particle travelling along ``path`` between loop fractions ``start`` and ``end``. */
function Particle({ path, start, end, className }: { path: string; start: number; end: number; className: string }) {
  return (
    <circle r="4.5" className={className} opacity="0">
      <animateMotion dur={LOOP} repeatCount="indefinite" path={path} calcMode="linear"
        keyPoints="0;0;1;1" keyTimes={times(0, start, end, 1)} />
      <animate attributeName="opacity" dur={LOOP} repeatCount="indefinite"
        values="0;0;1;1;0;0" keyTimes={times(0, start, start + 0.02, end - 0.02, end, 1)} />
    </circle>
  );
}

function Caption({ y, from, to, children }: { y: number; from: number; to: number; children: string }) {
  return (
    <text x="280" y={y} className="explain-caption" opacity="0">
      <animate attributeName="opacity" dur={LOOP} repeatCount="indefinite"
        values="0;0;1;1;0;0" keyTimes={times(0, from, from + 0.03, to - 0.03, to, 1)} />
      {children}
    </text>
  );
}

/**
 * Looping explainer: surplus energy flows into storage, storage discharges
 * into the deficit, and the supply − demand curve flattens so the tightest
 * hour is lifted. Static when the viewer prefers reduced motion.
 */
function Explainer() {
  const reduced = useReducedMotion();
  const phases = times(0, T.rest, T.charged, T.discharged, T.hold, 1);
  return (
    <svg className="explain" viewBox="0 0 560 200" role="img"
      aria-label="Energy from surplus hours charges storage, storage discharges into deficit hours, and the lowest point of supply minus demand rises">
      <defs>
        <linearGradient id="explain-surplus" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--heat-surplus)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="var(--heat-surplus)" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id="explain-deficit" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="var(--heat-deficit)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="var(--heat-deficit)" stopOpacity="0.04" />
        </linearGradient>
        <clipPath id="explain-cell"><rect x="266" y="68" width="28" height="44" rx="3" /></clipPath>
        <marker id="explain-arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
          <path d="M0 8 L4 0 L8 8 Z" className="explain-arrowhead" />
        </marker>
      </defs>

      <line x1="20" y1="90" x2="540" y2="90" className="explain-zero" />
      <path d="M20 90 C70 90 80 28 130 28 C180 28 190 90 240 90 Z" fill="url(#explain-surplus)" />
      <path d="M320 90 C370 90 380 152 430 152 C480 152 490 90 540 90 Z" fill="url(#explain-deficit)" />
      <path d={BEFORE} className="explain-before" />
      <text x="130" y="18" className="explain-label">surplus hours</text>
      <text x="430" y="172" className="explain-label">deficit hours</text>

      <g className="explain-battery">
        <rect x="272" y="58" width="16" height="6" rx="2" />
        <rect x="262" y="64" width="36" height="52" rx="7" className="explain-shell" />
        <g clipPath="url(#explain-cell)">
          <rect x="266" y={reduced ? 90 : 112} width="28" height={reduced ? 22 : 0} className="explain-level">
            {reduced ? null : (
              <>
                <animate attributeName="height" dur={LOOP} repeatCount="indefinite" values="0;0;44;6;6;0" keyTimes={phases} />
                <animate attributeName="y" dur={LOOP} repeatCount="indefinite" values="112;112;68;106;106;112" keyTimes={phases} />
              </>
            )}
          </rect>
        </g>
        <text x="280" y="134" className="explain-label">storage</text>
      </g>

      <path d={reduced ? AFTER : BEFORE} className="explain-after">
        {reduced ? null : (
          <animate attributeName="d" dur={LOOP} repeatCount="indefinite" calcMode="spline"
            keySplines="0 0 1 1;.45 0 .55 1;.45 0 .55 1;0 0 1 1;.45 0 .55 1"
            values={[BEFORE, BEFORE, CHARGED, AFTER, AFTER, BEFORE].join(";")} keyTimes={phases} />
        )}
      </path>

      <g opacity={reduced ? 1 : 0}>
        {reduced ? null : (
          <animate attributeName="opacity" dur={LOOP} repeatCount="indefinite"
            values="0;0;1;1;0;0" keyTimes={times(0, T.discharged - 0.04, T.discharged, T.hold - 0.03, T.hold, 1)} />
        )}
        <line x1="436" y1="150" x2="436" y2="124" className="explain-lift" markerEnd="url(#explain-arrow)" />
        <text x="444" y="142" className="explain-note">tightest hour lifted</text>
      </g>

      {reduced ? null : (
        <>
          {[0, 1, 2].map((i) => (
            <Particle key={`c${i}`} path={TO_STORAGE} className="explain-particle is-charge"
              start={T.rest + 0.02 + i * 0.07} end={T.rest + 0.16 + i * 0.07} />
          ))}
          {[0, 1, 2].map((i) => (
            <Particle key={`d${i}`} path={TO_DEFICIT} className="explain-particle is-discharge"
              start={T.charged + 0.01 + i * 0.07} end={T.charged + 0.15 + i * 0.07} />
          ))}
          <Caption y={196} from={T.rest - 0.02} to={T.charged}>1 · Surplus hours charge the storage</Caption>
          <Caption y={196} from={T.charged} to={T.discharged}>2 · Storage discharges into deficit hours</Caption>
          <Caption y={196} from={T.discharged} to={T.hold + 0.04}>3 · The tightest hours are lifted first</Caption>
        </>
      )}
    </svg>
  );
}

export function EmptyState({ onExample, loadingExample }: { onExample: () => void; loadingExample: boolean }) {
  return (
    <section className="empty">
      <Explainer />
      <h2>See how much storage can lift the tightest hours.</h2>
      <p>
        Upload a month or a full financial year of hourly demand and available supply, enter the storage size and
        other specifications, and the optimiser schedules charging and discharging to progressively move energy from
        surplus hours to deficit hours, tightest hours first.
      </p>
      <ol className="empty-steps">
        <li><b>1</b><span><strong>Hourly data</strong>Timestamp, Demand (GW), Available Supply (GW)</span></li>
        <li><b>2</b><span><strong>Storage</strong>Power, energy, efficiency and a daily cycle limit</span></li>
        <li><b>3</b><span><strong>Operation</strong>Starting and ending SOC, operating range, charging rule</span></li>
      </ol>
      <button type="button" className="secondary-button" onClick={onExample} disabled={loadingExample}>
        <FlaskConical size={15} aria-hidden="true" /> {loadingExample ? "Loading…" : "Try with example data"}
      </button>
      <p className="empty-foot">Runs entirely on this computer. Files are processed in memory and never leave it.</p>
    </section>
  );
}
