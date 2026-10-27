"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  type Reading,
  linearRegression,
  mean,
  median,
  minutesUntil,
  movingAverage,
  parseLine,
  stdDev,
} from "@/lib/stats";

// Minimal Web Serial types (not in TypeScript's DOM lib yet)
type SerialPortLike = {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
};
type SerialLike = { requestPort(): Promise<SerialPortLike> };

const WINDOWS = [
  { label: "5 min", ms: 5 * 60_000 },
  { label: "30 min", ms: 30 * 60_000 },
  { label: "All", ms: Infinity },
];
const MA_WINDOW = 5;

type Mode = "off" | "serial" | "demo";

export default function Dashboard() {
  const [readings, setReadings] = useState<Reading[]>([]);
  const [mode, setMode] = useState<Mode>("off");
  const [error, setError] = useState("");
  const [windowMs, setWindowMs] = useState(WINDOWS[0].ms);
  const [threshold, setThreshold] = useState(30);
  const [sent, setSent] = useState("");
  const [hasSerial, setHasSerial] = useState(true);

  const portRef = useRef<SerialPortLike | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const pipeRef = useRef<Promise<void> | null>(null);
  const demoRef = useRef({ pct: 62, soak: 0, clock: 0, start: 30 });

  useEffect(() => setHasSerial("serial" in navigator), []);

  const latest = readings.at(-1);

  // Keep the slider in sync with the Nano's stored threshold until the user moves it
  const touched = useRef(false);
  useEffect(() => {
    if (latest && !touched.current) setThreshold(latest.start);
  }, [latest]);

  async function connect() {
    setError("");
    try {
      const serial = (navigator as Navigator & { serial: SerialLike }).serial;
      const port = await serial.requestPort();
      await port.open({ baudRate: 9600 });
      portRef.current = port;
      setReadings([]);
      setMode("serial");

      const decoder = new TextDecoderStream();
      pipeRef.current = port.readable!.pipeTo(decoder.writable as WritableStream<Uint8Array>).catch(() => {});
      const reader = decoder.readable.getReader();
      readerRef.current = reader;

      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        const parsed = lines.map((l) => parseLine(l, Date.now())).filter((r): r is Reading => r !== null);
        if (parsed.length) setReadings((prev) => [...prev, ...parsed]);
      }
    } catch (e) {
      // Closing the picker without choosing a port isn't an error worth showing
      if (!(e instanceof DOMException && e.name === "NotFoundError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setMode("off");
    }
  }

  async function disconnect() {
    if (mode === "demo") {
      setMode("off");
      return;
    }
    await readerRef.current?.cancel().catch(() => {});
    await pipeRef.current;
    await portRef.current?.close().catch(() => {});
    portRef.current = null;
    setMode("off");
  }

  async function sendThreshold() {
    if (mode === "demo") {
      demoRef.current.start = threshold;
    } else {
      const writer = portRef.current?.writable?.getWriter();
      if (!writer) return;
      await writer.write(new TextEncoder().encode(`T${threshold}\n`));
      writer.releaseLock();
    }
    setSent(`Sent: pump starts below ${threshold}%`);
  }

  async function resetFault() {
    const writer = portRef.current?.writable?.getWriter();
    if (!writer) return;
    await writer.write(new TextEncoder().encode("R\n"));
    writer.releaseLock();
  }

  // Demo mode: simulated drying soil + pump bursts, 2 s of "plant time" every 150 ms
  function startDemo() {
    setError("");
    setReadings([]);
    demoRef.current = { pct: 62, soak: 0, clock: Date.now(), start: threshold };
    setMode("demo");
  }
  useEffect(() => {
    if (mode !== "demo") return;
    const id = setInterval(() => {
      const s = demoRef.current;
      s.clock += 2000;
      let status = "OK";
      if (s.soak > 0) {
        s.soak--;
        status = "Soaking...";
      } else if (s.pct < s.start) {
        s.pct += 14;
        s.soak = 15;
        status = "Watering...";
      }
      s.pct = Math.max(0, Math.min(100, s.pct - 0.35 + (Math.random() - 0.5) * 1.2));
      const pct = Math.round(s.pct);
      const raw = Math.round(800 - (pct / 100) * 450);
      setReadings((prev) => [...prev, { t: s.clock, raw, pct, start: s.start, status }]);
    }, 150);
    return () => clearInterval(id);
  }, [mode]);

  const t0 = readings[0]?.t ?? 0;
  const visible = useMemo(() => {
    if (!latest) return [];
    return readings.filter((r) => latest.t - r.t <= windowMs);
  }, [readings, latest, windowMs]);

  const analysis = useMemo(() => {
    if (visible.length < 2) return null;
    const xs = visible.map((r) => (r.t - t0) / 60_000);
    const ys = visible.map((r) => r.pct);
    // Fit the trend only to the current drying stretch (after the last watering/soak),
    // otherwise the refill jumps drag the gradient around.
    const lastPump = visible.findLastIndex((r) => r.status.startsWith("Watering") || r.status.startsWith("Soaking"));
    const fitFrom = lastPump >= 0 && visible.length - lastPump - 1 >= 3 ? lastPump + 1 : lastPump >= 0 ? -1 : 0;
    const fit = fitFrom >= 0 ? linearRegression(xs.slice(fitFrom), ys.slice(fitFrom)) : null;
    const ma = movingAverage(ys, MA_WINDOW);
    const start = visible.at(-1)!.start;
    return {
      n: ys.length,
      sum: ys.reduce((a, b) => a + b, 0),
      mean: mean(ys),
      median: median(ys),
      sd: stdDev(ys),
      min: Math.min(...ys),
      max: Math.max(...ys),
      fit,
      fitPoints: fitFrom >= 0 ? ys.length - fitFrom : 0,
      until: fit && minutesUntil(start, fit.slope, fit.intercept, xs.at(-1)!),
      rows: visible.map((r, i) => ({
        x: xs[i],
        pct: r.pct,
        ma: +ma[i].toFixed(2),
        trend: fit && i >= fitFrom ? +(fit.slope * xs[i] + fit.intercept).toFixed(2) : null,
        status: r.status,
        raw: r.raw,
      })),
      pumps: visible.filter((r) => r.status.startsWith("Watering")).map((r) => (r.t - t0) / 60_000),
    };
  }, [visible, t0]);

  function downloadCsv() {
    const header = "time,minutes,raw,moisture_pct,threshold_pct,status";
    const lines = readings.map((r) =>
      [new Date(r.t).toISOString(), ((r.t - t0) / 60_000).toFixed(3), r.raw, r.pct, r.start, r.status].join(","),
    );
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `moisture-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const status = latest?.status ?? "";
  const tone = status.startsWith("CHECK")
    ? "var(--critical)"
    : status.startsWith("Watering")
      ? "var(--series-1)"
      : status.startsWith("Soaking")
        ? "var(--warning)"
        : "var(--good)";

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Plant moisture</h1>
          <p className="text-sm text-[var(--text-2)]">
            Live readings from the Arduino Nano, with statistics and a linear trend.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mode === "off" ? (
            <>
              <button onClick={connect} disabled={!hasSerial} className="btn btn-primary">
                Connect Nano
              </button>
              <button onClick={startDemo} className="btn">
                Demo data
              </button>
            </>
          ) : (
            <>
              <span className="flex items-center gap-2 text-sm text-[var(--text-2)]">
                <span className="size-2 rounded-full bg-[var(--good)]" />
                {mode === "demo" ? "Demo mode" : "Connected"}
              </span>
              <button onClick={disconnect} className="btn">
                Disconnect
              </button>
            </>
          )}
        </div>
      </header>

      {!hasSerial && (
        <p className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm">
          This browser can&apos;t talk to USB serial. Open the dashboard in Chrome or Edge, or use Demo data.
        </p>
      )}
      {error && <p className="mt-4 text-sm text-[var(--critical)]">Couldn&apos;t connect: {error}</p>}

      {/* Headline numbers */}
      <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Moisture now" value={latest ? `${latest.pct}%` : "–"} sub={latest ? `raw ${latest.raw}` : "no data yet"} />
        <Tile label="Pump starts below" value={latest ? `${latest.start}%` : "–"} sub="stored on the Nano" />
        <Tile
          label="Status"
          value={
            latest ? (
              <span className="flex items-center gap-2">
                <span className="size-2.5 rounded-full" style={{ background: tone }} />
                {status.replace("...", "")}
              </span>
            ) : (
              "–"
            )
          }
          sub={latest ? `${readings.length} readings` : ""}
        />
        <Tile
          label="Predicted next watering"
          value={analysis?.until != null ? `${analysis.until.toFixed(1)} min` : "–"}
          sub={!analysis ? "" : !analysis.fit ? "just watered, collecting data" : analysis.fit.slope < 0 ? "from the trend line" : "soil isn't drying"}
        />
      </section>

      {/* Chart */}
      <section className="card mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Moisture over time</h2>
          <div className="flex rounded-lg border border-[var(--border)] p-0.5 text-sm" role="group" aria-label="Time range">
            {WINDOWS.map((w) => (
              <button
                key={w.label}
                onClick={() => setWindowMs(w.ms)}
                aria-pressed={windowMs === w.ms}
                className={`rounded-md px-3 py-1 ${windowMs === w.ms ? "bg-[var(--text)] text-[var(--surface)]" : "text-[var(--text-2)]"}`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4 h-80">
          {analysis ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={analysis.rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis
                  dataKey="x"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(v: number) => v.toFixed(1)}
                  stroke="var(--muted)"
                  fontSize={12}
                  label={{ value: "time (minutes)", position: "insideBottom", offset: -4, fill: "var(--muted)", fontSize: 12 }}
                  height={40}
                />
                <YAxis domain={[0, 100]} unit="%" stroke="var(--muted)" fontSize={12} width={48} />
                <Tooltip
                  contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13 }}
                  labelStyle={{ color: "var(--text-2)" }}
                  itemStyle={{ color: "var(--text)" }}
                  labelFormatter={(v) => `t = ${Number(v).toFixed(2)} min`}
                  formatter={(v, name) => [`${Number(v).toFixed(1)}%`, name]}
                />
                <Legend verticalAlign="top" height={32} wrapperStyle={{ fontSize: 13, color: "var(--text-2)" }} />
                <ReferenceLine
                  y={latest!.start}
                  stroke="var(--critical)"
                  strokeDasharray="6 4"
                  label={{ value: `pump starts < ${latest!.start}%`, position: "insideBottomRight", fill: "var(--text-2)", fontSize: 12 }}
                />
                {analysis.pumps.map((x) => (
                  <ReferenceLine key={x} x={x} stroke="var(--series-1)" strokeOpacity={0.35} />
                ))}
                <Line name="Moisture" dataKey="pct" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line name={`Moving average (${MA_WINDOW})`} dataKey="ma" stroke="var(--series-2)" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line name="Linear trend" dataKey="trend" stroke="var(--series-3)" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="grid h-full place-items-center text-sm text-[var(--muted)]">
              Connect the Nano or start demo data to see the graph.
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-[var(--muted)]">Faint vertical lines mark pump bursts.</p>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Threshold control */}
        <section className="card">
          <h2 className="font-medium">Pump threshold</h2>
          <p className="mt-1 text-sm text-[var(--text-2)]">
            The pump starts when moisture drops below this, and keeps watering until it reaches {Math.min(threshold + 30, 100)}%.
          </p>
          <div className="mt-4 flex items-center gap-4">
            <input
              type="range"
              min={1}
              max={95}
              value={threshold}
              onChange={(e) => {
                touched.current = true;
                setThreshold(+e.target.value);
                setSent("");
              }}
              className="w-full accent-[var(--series-1)]"
              aria-label="Pump start threshold"
            />
            <span className="w-14 text-right text-xl font-semibold tabular-nums">{threshold}%</span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button onClick={sendThreshold} disabled={mode === "off"} className="btn btn-primary">
              Send to Nano
            </button>
            {mode === "serial" && status.startsWith("CHECK") && (
              <button onClick={resetFault} className="btn">
                Clear tank alarm
              </button>
            )}
            <span className="text-sm text-[var(--text-2)]">{sent}</span>
          </div>
        </section>

        {/* Maths */}
        <section className="card">
          <h2 className="font-medium">The maths</h2>
          {analysis ? (
            <dl className="mt-3 space-y-3 text-sm">
              <Formula
                name="Mean"
                formula="x̄ = Σx ÷ n"
                working={`${analysis.sum} ÷ ${analysis.n} = ${analysis.mean.toFixed(2)}%`}
              />
              <Formula name="Median" formula="middle value when sorted" working={`${analysis.median}%`} />
              <Formula
                name="Standard deviation"
                formula="σ = √( Σ(x − x̄)² ÷ n )"
                working={`${analysis.sd.toFixed(2)}%`}
              />
              <Formula name="Range" formula="max − min" working={`${analysis.max} − ${analysis.min} = ${analysis.max - analysis.min}%`} />
              {analysis.fit ? (
                <>
                  <Formula
                    name={`Linear trend since last watering (${analysis.fitPoints} points)`}
                    formula="y = mx + c, least squares"
                    working={`y = ${analysis.fit.slope.toFixed(3)}x + ${analysis.fit.intercept.toFixed(2)}   (r² = ${analysis.fit.r2.toFixed(3)})`}
                  />
                  <Formula
                    name="Drying rate"
                    formula="m, the gradient"
                    working={`${analysis.fit.slope.toFixed(3)} % per minute`}
                  />
                  <Formula
                    name="When will it need water?"
                    formula={`solve mx + c = ${latest!.start}`}
                    working={
                      analysis.until != null
                        ? `x = (${latest!.start} − ${analysis.fit.intercept.toFixed(2)}) ÷ ${analysis.fit.slope.toFixed(3)} → ${analysis.until.toFixed(1)} min from now`
                        : "trend isn't falling towards the threshold"
                    }
                  />
                </>
              ) : (
                <Formula name="Linear trend" formula="y = mx + c" working="just watered, waiting for 3 readings" />
              )}
            </dl>
          ) : (
            <p className="mt-3 text-sm text-[var(--muted)]">Needs at least 2 readings.</p>
          )}
          <p className="mt-4 text-xs text-[var(--muted)]">Calculated over the selected time range.</p>
        </section>
      </div>

      {/* Data table */}
      <section className="card mt-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium">Latest readings</h2>
          <button onClick={downloadCsv} disabled={!readings.length} className="btn">
            Download CSV
          </button>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-left text-[var(--muted)]">
              <tr>
                <th className="py-2 pr-4 font-normal">Time</th>
                <th className="py-2 pr-4 font-normal">Minute</th>
                <th className="py-2 pr-4 font-normal">Raw</th>
                <th className="py-2 pr-4 font-normal">Moisture</th>
                <th className="py-2 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {readings
                .slice(-12)
                .reverse()
                .map((r) => (
                  <tr key={r.t} className="border-t border-[var(--border)]">
                    <td className="py-1.5 pr-4">{new Date(r.t).toLocaleTimeString()}</td>
                    <td className="py-1.5 pr-4">{((r.t - t0) / 60_000).toFixed(2)}</td>
                    <td className="py-1.5 pr-4">{r.raw}</td>
                    <td className="py-1.5 pr-4">{r.pct}%</td>
                    <td className="py-1.5">{r.status}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {!readings.length && <p className="py-4 text-sm text-[var(--muted)]">No readings yet.</p>}
        </div>
      </section>
    </main>
  );
}

function Tile({ label, value, sub }: { label: string; value: React.ReactNode; sub: string }) {
  return (
    <div className="card">
      <div className="text-xs text-[var(--text-2)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-[var(--muted)]">{sub}</div>
    </div>
  );
}

function Formula({ name, formula, working }: { name: string; formula: string; working: string }) {
  return (
    <div className="border-t border-[var(--border)] pt-3 first:border-0 first:pt-0">
      <dt className="flex flex-wrap justify-between gap-2">
        <span className="text-[var(--text-2)]">{name}</span>
        <span className="font-mono text-xs text-[var(--muted)]">{formula}</span>
      </dt>
      <dd className="mt-0.5 font-mono">{working}</dd>
    </div>
  );
}
