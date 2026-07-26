import {
  AlertTriangle,
  ArrowLeft,
  BriefcaseBusiness,
  Check,
  CircleDollarSign,
  ExternalLink,
  FileCheck2,
  RefreshCw,
  TrendingDown
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PositionView, ValuationObservation } from "../domain/positions";
import type { FundingTransaction } from "../domain/schemas";
import {
  getPosition,
  getPositions,
  liquidatePosition,
  previewLiquidation,
  repayPosition
} from "./api";

export type PositionRoute = "positions" | "position" | "repay";

const usd = (minor: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);

const date = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(value));

function positionName(position: PositionView): string {
  const label = position.advance.market.externalEvidenceLabel;
  if (label) return label.split(" · ")[0] ?? position.advance.market.assetSymbol;
  return position.advance.market.assetSymbol.replace(".PVT", "");
}

function positionStatus(position: PositionView): string {
  switch (position.advance.state) {
    case "REPAID":
      return "Repaid";
    case "LIQUIDATED":
      return "Liquidated";
    case "REPAYMENT_PENDING":
      return "Repayment pending";
    case "REPAYMENT_REVIEW_REQUIRED":
      return "Repayment review";
    case "LIQUIDATION_PENDING":
      return "Liquidation pending";
    case "LIQUIDATION_REVIEW_REQUIRED":
      return "Liquidation review";
    default:
      return "Open";
  }
}

function PositionChart({
  observations,
  thresholdMinor,
  strikeMinor,
  previewMinor
}: {
  observations: ValuationObservation[];
  thresholdMinor: number;
  strikeMinor: number;
  previewMinor: number | null;
}) {
  const width = 760;
  const height = 320;
  const padding = { left: 58, right: 24, top: 26, bottom: 42 };
  const values = [
    ...observations.map((item) => item.priceUsdMinor),
    thresholdMinor,
    strikeMinor,
    previewMinor ?? 0
  ].filter((value) => value > 0);
  const maxValue = Math.max(...values, 100);
  const ceiling = Math.ceil((maxValue * 1.18) / 100) * 100;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const y = (minor: number) => padding.top + plotHeight - (minor / ceiling) * plotHeight;
  const points = observations.map((item, index) => ({
    ...item,
    x:
      observations.length <= 1
        ? padding.left + plotWidth
        : padding.left + (index / (observations.length - 1)) * plotWidth,
    y: y(item.priceUsdMinor)
  }));
  const stepPath =
    points.length === 0
      ? ""
      : points
          .map((point, index) =>
            index === 0 ? `M ${point.x} ${point.y}` : `H ${point.x} V ${point.y}`
          )
          .join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="position-chart">
      <div className="chart-legend">
        <span>
          <i className="legend-line valuation" />
          Valuation per share
        </span>
        {strikeMinor > 0 ? (
          <span>
            <i className="legend-line strike" />
            Strike price
          </span>
        ) : null}
        <span>
          <i className="legend-line threshold" />
          Liquidation threshold
        </span>
        <span>
          <i className="legend-area" />
          Below threshold
        </span>
      </div>
      <svg
        aria-label="Private valuation snapshots and liquidation threshold"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <rect
          className="chart-risk-area"
          height={Math.max(0, padding.top + plotHeight - y(thresholdMinor))}
          width={plotWidth}
          x={padding.left}
          y={y(thresholdMinor)}
        />
        {ticks.map((tick) => {
          const value = Math.round(ceiling * tick);
          const tickY = y(value);
          return (
            <g key={tick}>
              <line
                className="chart-grid"
                x1={padding.left}
                x2={width - padding.right}
                y1={tickY}
                y2={tickY}
              />
              <text className="chart-axis-label" x={padding.left - 10} y={tickY + 4}>
                {usd(value)}
              </text>
            </g>
          );
        })}
        {strikeMinor > 0 ? (
          <line
            className="chart-strike"
            x1={padding.left}
            x2={width - padding.right}
            y1={y(strikeMinor)}
            y2={y(strikeMinor)}
          />
        ) : null}
        <line
          className="chart-threshold"
          x1={padding.left}
          x2={width - padding.right}
          y1={y(thresholdMinor)}
          y2={y(thresholdMinor)}
        />
        {stepPath ? <path className="chart-price" d={stepPath} fill="none" /> : null}
        {points.map((point) => (
          <g key={`${point.observedAt}-${point.priceUsdMinor}`}>
            <circle className="chart-point" cx={point.x} cy={point.y} r="5" />
            <text className="chart-date" x={point.x} y={height - 14} textAnchor="middle">
              {date(point.observedAt)}
            </text>
          </g>
        ))}
        {previewMinor ? (
          <g>
            <line
              className="chart-preview"
              x1={padding.left}
              x2={width - padding.right}
              y1={y(previewMinor)}
              y2={y(previewMinor)}
            />
            <text
              className="chart-preview-label"
              x={width - padding.right}
              y={y(previewMinor) - 8}
              textAnchor="end"
            >
              Emulated {usd(previewMinor)}
            </text>
          </g>
        ) : null}
      </svg>
      <p className="chart-disclosure">
        Private valuation snapshots are reference evidence, not a continuously traded market price.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="positions-empty">
      <RefreshCw aria-hidden="true" className="is-spinning" size={22} />
      <p>Loading positions…</p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="positions-empty is-error">
      <AlertTriangle aria-hidden="true" size={24} />
      <strong>Unable to load positions</strong>
      <p>{message}</p>
      <button onClick={onRetry} type="button">
        Try again
      </button>
    </div>
  );
}

export function PositionsPage({
  onOpen,
  onRepay
}: {
  onOpen: (advanceId: string) => void;
  onRepay: (advanceId: string) => void;
}) {
  const [tab, setTab] = useState<"open" | "closed">("open");
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    void reloadKey;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getPositions(tab)
      .then((items) => {
        if (!cancelled) setPositions(items);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "POSITIONS_FAILED");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, reloadKey]);

  const outstanding = positions.reduce(
    (total, position) => total + position.remainingPrincipalMinor,
    0
  );

  return (
    <section className="positions-screen">
      <div className="positions-heading">
        <div>
          <h1>Positions</h1>
          <p>Review outstanding Demo USDC debt and synthetic collateral.</p>
        </div>
      </div>
      <div className="position-tabs" role="tablist" aria-label="Position status">
        {(["open", "closed"] as const).map((value) => (
          <button
            aria-selected={tab === value}
            className={tab === value ? "is-active" : ""}
            key={value}
            onClick={() => setTab(value)}
            role="tab"
            type="button"
          >
            {value === "open" ? "Open" : "Closed"}
          </button>
        ))}
      </div>
      <div className="positions-summary">
        <div>
          <span className="summary-icon">
            <CircleDollarSign aria-hidden="true" size={24} />
          </span>
          <span>
            <small>{tab === "open" ? "Outstanding debt" : "Closed principal"}</small>
            <strong>{usd(outstanding)}</strong>
            <em>Demo USDC — no real value</em>
          </span>
        </div>
        <div>
          <span className="summary-icon">
            <BriefcaseBusiness aria-hidden="true" size={24} />
          </span>
          <span>
            <small>{tab === "open" ? "Open positions" : "Closed positions"}</small>
            <strong>{positions.length}</strong>
            <em>{tab === "open" ? "Positions with outstanding debt" : "Repaid or liquidated"}</em>
          </span>
        </div>
      </div>

      {loading ? <LoadingState /> : null}
      {error ? (
        <ErrorState message={error} onRetry={() => setReloadKey((value) => value + 1)} />
      ) : null}
      {!loading && !error ? (
        positions.length === 0 ? (
          <div className="positions-empty">
            <BriefcaseBusiness aria-hidden="true" size={26} />
            <strong>No {tab} positions</strong>
            <p>
              {tab === "open"
                ? "Fund a financing request to create a position."
                : "Closed positions will appear here."}
            </p>
          </div>
        ) : (
          <div className="positions-table-wrap">
            <table className="positions-table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Status</th>
                  <th>Remaining debt</th>
                  <th>Liquidation threshold</th>
                  <th>Created</th>
                  <th>Maturity</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => (
                  <tr key={position.advance.advanceId}>
                    <td>
                      <strong>{positionName(position)}</strong>
                      <span>
                        {position.advance.market.assetSymbol} · {position.grantSummary.grantType}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`position-state state-${position.advance.state.toLowerCase()}`}
                      >
                        {positionStatus(position)}
                      </span>
                    </td>
                    <td>
                      <strong>{usd(position.remainingPrincipalMinor)}</strong>
                      <span>Demo USDC</span>
                    </td>
                    <td>
                      <strong>{usd(position.liquidationPriceMinor)}</strong>
                      <span>per share</span>
                    </td>
                    <td>{date(position.fundedAt)}</td>
                    <td>{date(position.maturityAt)}</td>
                    <td>
                      <button
                        className="table-action"
                        onClick={() => onOpen(position.advance.advanceId)}
                        type="button"
                      >
                        View position
                      </button>
                      {position.remainingPrincipalMinor > 0 &&
                      position.advance.state === "FUNDED" ? (
                        <button
                          className="table-action is-danger"
                          onClick={() => onRepay(position.advance.advanceId)}
                          type="button"
                        >
                          Close debt
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
      <div className="synthetic-disclosure">
        <AlertTriangle aria-hidden="true" size={18} />
        <span>
          Demo USDC has no real value. Synthetic collateral represents no real shares or legal
          claim.
        </span>
      </div>
    </section>
  );
}

function usePosition(advanceId: string, refreshKey = 0) {
  const [position, setPosition] = useState<PositionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void refreshKey;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getPosition(advanceId)
      .then((result) => {
        if (!cancelled) setPosition(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "POSITION_FAILED");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [advanceId, refreshKey]);
  return { position, setPosition, loading, error };
}

export function PositionDetailPage({
  advanceId,
  onBack,
  onRepay
}: {
  advanceId: string;
  onBack: () => void;
  onRepay: () => void;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const { position, setPosition, loading, error } = usePosition(advanceId, refreshKey);
  const [dropPrice, setDropPrice] = useState("");
  const [preview, setPreview] = useState<
    Awaited<ReturnType<typeof previewLiquidation>>["preview"] | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!position || dropPrice) return;
    setDropPrice((Math.max(1, position.liquidationPriceMinor - 1) / 100).toFixed(2));
  }, [position, dropPrice]);

  if (loading) return <LoadingState />;
  if (error || !position) {
    return (
      <ErrorState
        message={error ?? "POSITION_NOT_FOUND"}
        onRetry={() => setRefreshKey((value) => value + 1)}
      />
    );
  }
  const grant = position.grantSummary;
  const current =
    position.valuations.at(-1)?.priceUsdMinor ?? position.advance.market.priceUsdMinor;

  async function runPreview() {
    const priceMinor = Math.round(Number(dropPrice) * 100);
    setBusy(true);
    setActionError(null);
    try {
      const result = await previewLiquidation(advanceId, priceMinor);
      setPreview(result.preview);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "LIQUIDATION_PREVIEW_FAILED");
    } finally {
      setBusy(false);
    }
  }

  async function confirmLiquidation() {
    if (!preview?.wouldLiquidate) return;
    setBusy(true);
    setActionError(null);
    try {
      const liquidationId = `ub_liq_${crypto.randomUUID().replaceAll("-", "")}`;
      const result = await liquidatePosition(advanceId, liquidationId, preview.emulatedPriceMinor);
      setPosition(result.position);
      setPreview(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "LIQUIDATION_FAILED");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="position-detail-screen">
      <button className="back-link" onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={17} />
        Back to positions
      </button>
      <div className="position-title-row">
        <div>
          <h1>{positionName(position)}</h1>
          <p>
            {position.advance.market.assetSymbol} · {grant?.grantType ?? "Equity"} ·{" "}
            {positionStatus(position)}
          </p>
        </div>
        {position.advance.state === "FUNDED" ? (
          <button className="outline-danger" onClick={onRepay} type="button">
            Close debt
          </button>
        ) : null}
      </div>
      <div className="position-detail-grid">
        <section className="position-chart-panel">
          <div className="panel-heading">
            <div>
              <h2>Valuation over time</h2>
              <p>Per-share private valuation evidence</p>
            </div>
            <strong>{usd(current)}</strong>
          </div>
          <PositionChart
            observations={position.valuations}
            previewMinor={preview?.emulatedPriceMinor ?? null}
            strikeMinor={grant?.strikePriceMinor ?? position.advance.pricing.strikePriceMinor}
            thresholdMinor={position.liquidationPriceMinor}
          />
        </section>
        <aside className="position-metrics">
          <dl>
            <div>
              <dt>Original debt</dt>
              <dd>{usd(position.originalPrincipalMinor)} Demo USDC</dd>
            </div>
            <div>
              <dt>Remaining debt</dt>
              <dd>{usd(position.remainingPrincipalMinor)} Demo USDC</dd>
            </div>
            <div>
              <dt>Current valuation</dt>
              <dd>{usd(current)} per share</dd>
            </div>
            <div>
              <dt>Liquidation threshold</dt>
              <dd>{usd(position.liquidationPriceMinor)} per share</dd>
            </div>
            {grant?.strikePriceMinor ? (
              <div>
                <dt>Strike price</dt>
                <dd>{usd(grant.strikePriceMinor)} per share</dd>
              </div>
            ) : null}
            <div>
              <dt>Created</dt>
              <dd>{date(position.fundedAt)}</dd>
            </div>
            <div>
              <dt>Maturity</dt>
              <dd>{date(position.maturityAt)}</dd>
            </div>
            <div>
              <dt>Advance Note</dt>
              <dd>
                {position.advance.funding && "version" in position.advance.funding ? (
                  <a
                    href={position.advance.funding.note.hashscanUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    View on HashScan <ExternalLink aria-hidden="true" size={13} />
                  </a>
                ) : (
                  "Legacy receipt"
                )}
              </dd>
            </div>
            <div>
              <dt>Synthetic collateral NFT</dt>
              <dd>
                {position.collateral ? (
                  <a href={position.collateral.hashscanUrl} rel="noreferrer" target="_blank">
                    {position.collateral.tokenId}/{position.collateral.serial}{" "}
                    <ExternalLink aria-hidden="true" size={13} />
                  </a>
                ) : (
                  "Legacy position"
                )}
              </dd>
            </div>
          </dl>
        </aside>
      </div>
      {position.advance.state === "FUNDED" && position.collateral ? (
        <section className="price-emulator">
          <div>
            <TrendingDown aria-hidden="true" size={24} />
            <span>
              <strong>Emulate price drop</strong>
              <small>Preview a synthetic valuation below the risk threshold.</small>
            </span>
          </div>
          <label>
            Emulated price
            <span className="money-input">
              <span>$</span>
              <input
                inputMode="decimal"
                onChange={(event) => {
                  setDropPrice(event.target.value);
                  setPreview(null);
                }}
                value={dropPrice}
              />
            </span>
          </label>
          <button disabled={busy || !dropPrice} onClick={runPreview} type="button">
            {busy ? "Checking…" : "Preview impact"}
          </button>
          {preview ? (
            <div className={`liquidation-preview ${preview.wouldLiquidate ? "will-trigger" : ""}`}>
              <AlertTriangle aria-hidden="true" size={21} />
              <span>
                <strong>
                  {preview.wouldLiquidate
                    ? "Liquidation threshold crossed"
                    : "Position remains above threshold"}
                </strong>
                <small>
                  {usd(preview.emulatedPriceMinor)} simulated price · threshold{" "}
                  {usd(preview.liquidationPriceMinor)}
                </small>
              </span>
              <button
                disabled={!preview.wouldLiquidate || busy}
                onClick={confirmLiquidation}
                type="button"
              >
                Confirm demo liquidation
              </button>
            </div>
          ) : null}
          {actionError ? <p className="inline-error">{actionError}</p> : null}
          <p className="emulator-disclosure">
            This control creates synthetic Testnet evidence only. It does not sell or seize real
            employee equity.
          </p>
        </section>
      ) : null}
      {position.advance.state === "LIQUIDATED" ? (
        <section className="closed-position-banner">
          <Check aria-hidden="true" size={22} />
          <span>
            <strong>Position liquidated in the demo</strong>
            <small>
              The synthetic collateral NFT moved to the pool and the Advance Note was retired.
            </small>
          </span>
        </section>
      ) : null}
    </section>
  );
}

export function RepaymentPage({
  advanceId,
  onBack,
  onUpdated
}: {
  advanceId: string;
  onBack: () => void;
  onUpdated?: (position: PositionView) => void;
}) {
  const { position, setPosition, loading, error } = usePosition(advanceId);
  const [mode, setMode] = useState<"full" | "partial">("full");
  const [customAmount, setCustomAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<PositionView | null>(null);
  const amountMinor =
    mode === "full"
      ? (position?.remainingPrincipalMinor ?? 0)
      : Math.round(Number(customAmount || 0) * 100);
  const afterMinor = Math.max(0, (position?.remainingPrincipalMinor ?? 0) - amountMinor);
  const afterThreshold = useMemo(() => {
    if (!position) return 0;
    const currentThreshold = position.liquidationPriceMinor;
    if (position.remainingPrincipalMinor === 0 || afterMinor === 0) return 0;
    if (position.grantSummary.grantType === "RSU") {
      return Math.ceil((currentThreshold * afterMinor) / position.remainingPrincipalMinor);
    }
    const strike = position.grantSummary.strikePriceMinor;
    return (
      strike +
      Math.ceil(((currentThreshold - strike) * afterMinor) / position.remainingPrincipalMinor)
    );
  }, [afterMinor, position]);

  if (loading) return <LoadingState />;
  if (error || !position)
    return <ErrorState message={error ?? "POSITION_NOT_FOUND"} onRetry={onBack} />;

  async function submit() {
    if (!position || amountMinor <= 0 || amountMinor > position.remainingPrincipalMinor) return;
    setBusy(true);
    setActionError(null);
    try {
      const repaymentId = `ub_rp_${crypto.randomUUID().replaceAll("-", "")}`;
      const result = await repayPosition(advanceId, repaymentId, amountMinor);
      setPosition(result.position);
      setCompleted(result.position);
      onUpdated?.(result.position);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "REPAYMENT_FAILED");
    } finally {
      setBusy(false);
    }
  }

  const latestRepayment = completed?.advance.repayments?.at(-1)?.result;
  if (completed && latestRepayment) {
    const full = completed.remainingPrincipalMinor === 0;
    const resultTransactions: Array<[string, FundingTransaction]> =
      latestRepayment.version === 2
        ? [
            ["Repayment authorization", latestRepayment.transactions.authorization],
            ["Demo USDC settlement", latestRepayment.transactions.settlement],
            ["Advance Note retirement", latestRepayment.transactions.noteBurn],
            ["Final HCS record", latestRepayment.transactions.completionEvent]
          ].filter((item): item is [string, FundingTransaction] => item[1] !== undefined)
        : [];
    return (
      <section className="repayment-screen">
        <button className="back-link" onClick={onBack} type="button">
          <ArrowLeft aria-hidden="true" size={17} />
          Back to position
        </button>
        <div className="repayment-success">
          <span className="success-mark">
            <Check aria-hidden="true" size={30} />
          </span>
          <div>
            <h1>{full ? "Debt closed" : "Partial repayment complete"}</h1>
            <p>{usd(amountMinor)} Demo USDC returned to the treasury.</p>
          </div>
          <dl>
            <div>
              <dt>Remaining principal</dt>
              <dd>{usd(completed.remainingPrincipalMinor)}</dd>
            </div>
            <div>
              <dt>Synthetic collateral</dt>
              <dd>{full ? "Returned" : "Remains in escrow"}</dd>
            </div>
            <div>
              <dt>Advance Note</dt>
              <dd>{full ? "Retired" : "Active"}</dd>
            </div>
          </dl>
          {resultTransactions.length > 0 ? (
            <div className="repayment-links">
              {resultTransactions.map(([label, transaction]) => (
                <a
                  href={transaction?.hashscanUrl}
                  key={label as string}
                  rel="noreferrer"
                  target="_blank"
                >
                  {label as string}
                  <ExternalLink aria-hidden="true" size={14} />
                </a>
              ))}
            </div>
          ) : null}
          <button onClick={onBack} type="button">
            Return to position
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="repayment-screen">
      <button className="back-link" onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={17} />
        Back to position
      </button>
      <div className="positions-heading">
        <div>
          <h1>Close debt</h1>
          <p>Choose a full payoff or reduce the outstanding principal.</p>
        </div>
      </div>
      <div className="repayment-layout">
        <div className="repayment-form">
          <div className="repayment-position-summary">
            <div>
              <strong>{positionName(position)}</strong>
              <span>
                {position.advance.market.assetSymbol} · {positionStatus(position)}
              </span>
            </div>
            <div>
              <small>Remaining debt</small>
              <strong>{usd(position.remainingPrincipalMinor)}</strong>
              <span>Demo USDC</span>
            </div>
            <div>
              <small>Liquidation threshold</small>
              <strong>{usd(position.liquidationPriceMinor)}</strong>
              <span>per share</span>
            </div>
          </div>
          <section className="repayment-step">
            <h2>
              <span>1</span>Repayment amount
            </h2>
            <label className={`repayment-choice ${mode === "full" ? "is-selected" : ""}`}>
              <input
                checked={mode === "full"}
                name="repayment-mode"
                onChange={() => setMode("full")}
                type="radio"
              />
              <span>
                <strong>Full payoff</strong>
                <small>Repay the entire remaining debt</small>
              </span>
              <b>{usd(position.remainingPrincipalMinor)}</b>
            </label>
            <label className={`repayment-choice ${mode === "partial" ? "is-selected" : ""}`}>
              <input
                checked={mode === "partial"}
                name="repayment-mode"
                onChange={() => setMode("partial")}
                type="radio"
              />
              <span>
                <strong>Custom amount</strong>
                <small>Enter a partial repayment</small>
              </span>
              <span className="money-input">
                <span>$</span>
                <input
                  disabled={mode !== "partial"}
                  inputMode="decimal"
                  onChange={(event) => setCustomAmount(event.target.value)}
                  placeholder="0.00"
                  value={customAmount}
                />
              </span>
            </label>
            <div className="impact-summary">
              <div>
                <span>Remaining principal</span>
                <b>{usd(position.remainingPrincipalMinor)}</b>
                <i>→</i>
                <strong>{usd(afterMinor)}</strong>
              </div>
              <div>
                <span>Liquidation threshold</span>
                <b>{usd(position.liquidationPriceMinor)}</b>
                <i>→</i>
                <strong>{usd(afterThreshold)}</strong>
              </div>
            </div>
          </section>
          <section className="repayment-step">
            <h2>
              <span>2</span>Repayment details
            </h2>
            <dl>
              <div>
                <dt>Repayment asset</dt>
                <dd>Demo USDC — no real value</dd>
              </div>
              <div>
                <dt>Interest</dt>
                <dd>$0.00</dd>
              </div>
              <div>
                <dt>Fees</dt>
                <dd>$0.00</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>Hedera Testnet · Ready</dd>
              </div>
            </dl>
          </section>
          {actionError ? <p className="inline-error">{actionError}</p> : null}
          <div className="repayment-actions">
            <button className="secondary" onClick={onBack} type="button">
              Cancel
            </button>
            <button
              disabled={busy || amountMinor <= 0 || amountMinor > position.remainingPrincipalMinor}
              onClick={submit}
              type="button"
            >
              {busy ? "Submitting to Hedera…" : "Confirm repayment"}
            </button>
          </div>
        </div>
        <aside className="repayment-review">
          <h2>Hedera repayment</h2>
          <p>Review the transaction workflow.</p>
          <ol>
            <li>
              <span>1</span>
              <div>
                <strong>Repayment authorization</strong>
                <small>Recorded through Hedera Consensus Service.</small>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Demo USDC settlement</strong>
                <small>The exact amount returns to the treasury.</small>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>
                  {afterMinor === 0
                    ? "Collateral release and note retirement"
                    : "Position remains active"}
                </strong>
                <small>
                  {afterMinor === 0
                    ? "Synthetic collateral returns and the Advance Note is retired."
                    : "Both NFTs remain locked until the debt reaches zero."}
                </small>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <strong>Final HCS record</strong>
                <small>The remaining principal is publicly committed.</small>
              </div>
            </li>
          </ol>
          <div className="review-disclosure">
            <FileCheck2 aria-hidden="true" size={18} />
            <span>
              Demo USDC has no real value. Synthetic collateral represents no real shares.
            </span>
          </div>
        </aside>
      </div>
    </section>
  );
}
