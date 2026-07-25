import type { LucideIcon } from "lucide-react";
import {
  Bell,
  Building2,
  Check,
  ChevronDown,
  CircleDollarSign,
  ExternalLink,
  FileCheck2,
  Home,
  Landmark,
  LockKeyhole,
  Menu,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  WalletCards,
  X
} from "lucide-react";
import { useMemo, useState } from "react";
import type { PublicAdvance } from "../domain/public";
import type { AdvanceRequest, AssetSymbol } from "../domain/schemas";
import { evaluateAdvance, fundAdvance } from "./api";

type FormState = {
  asset: AssetSymbol;
  account: string;
  income: string;
  units: string;
  strike: string;
  amount: string;
  term: "14" | "30" | "45";
};

const initialForm: FormState = {
  asset: "AAPL",
  account: "0.0.653284",
  income: "6500",
  units: "120.0000",
  strike: "0",
  amount: "1500",
  term: "30"
};

const navItems: Array<{ label: string; href: string; icon: LucideIcon }> = [
  { label: "Home", href: "#overview", icon: Home },
  { label: "Equity", href: "#equity", icon: WalletCards },
  { label: "Evidence", href: "#evidence", icon: ShieldCheck },
  { label: "Advance", href: "#advance", icon: CircleDollarSign },
  { label: "Receipts", href: "#receipt", icon: ReceiptText }
];

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <nav className="primary-nav" aria-label="Main navigation">
        {navItems.map(({ label, href, icon: NavIcon }, index) => (
          <a
            className={index === 0 ? "is-current" : ""}
            href={href}
            key={label}
            onClick={onNavigate}
          >
            <NavIcon aria-hidden="true" size={20} strokeWidth={1.7} />
            <span>{label}</span>
            {label === "Equity" || label === "Advance" ? (
              <ChevronDown aria-hidden="true" className="nav-chevron" size={16} />
            ) : null}
          </a>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="network-card">
          <span className="network-dot" />
          <div>
            <strong>Hedera Testnet</strong>
            <span>Network status: healthy</span>
          </div>
        </div>
        <button className="profile-button" type="button">
          <span className="avatar">D</span>
          <span>
            <strong>Dmitry</strong>
            <small>Synthetic profile</small>
          </span>
          <ChevronDown aria-hidden="true" size={16} />
        </button>
      </div>
    </>
  );
}

function Field({
  label,
  prefix,
  value,
  onChange,
  help,
  inputMode = "decimal"
}: {
  label: string;
  prefix: string;
  value: string;
  onChange: (value: string) => void;
  help: string;
  inputMode?: "decimal" | "text";
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="control">
        <span className="control-prefix">{prefix}</span>
        <input
          autoComplete="off"
          inputMode={inputMode}
          onChange={(event) => onChange(event.target.value)}
          required
          value={value}
        />
      </span>
      <span className="field-help">{help}</span>
    </label>
  );
}

function EvidenceStep({
  icon: StepIcon,
  title,
  status,
  rows,
  active
}: {
  icon: LucideIcon;
  title: string;
  status: string;
  rows: Array<[string, string]>;
  active: boolean;
}) {
  return (
    <section className={`evidence-step ${active ? "is-active" : ""}`}>
      <div className="evidence-heading">
        <span className="evidence-icon">
          <StepIcon aria-hidden="true" size={19} strokeWidth={1.8} />
        </span>
        <div>
          <h3>{title}</h3>
          <span className="status">{status}</span>
        </div>
      </div>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd title={value}>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const usd = (minor: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(minor / 100);

function buildInput(form: FormState): AdvanceRequest {
  const id = crypto.randomUUID().replaceAll("-", "");
  return {
    requestId: `ub_req_${id}`,
    employeeRef: `ub_emp_${crypto.randomUUID().replaceAll("-", "")}`,
    recipientAccountId: form.account,
    synthetic: true,
    employment: {
      tenureMonths: 38,
      monthlyNetIncomeMinor: Math.round(Number(form.income) * 100),
      statusVerified: true
    },
    grant: {
      assetSymbol: form.asset,
      grantType: form.asset === "WHOOP" ? "OPTION" : "RSU",
      vestedUnits: form.units,
      strikePriceMinor: form.asset === "WHOOP" ? Math.round(Number(form.strike) * 100) : 0,
      transferRestricted: true,
      attestationCommitment: `sha256:${"a".repeat(64)}`
    },
    request: {
      amountMinor: Math.round(Number(form.amount) * 100),
      currency: "USD",
      termDays: Number(form.term) as 14 | 30 | 45
    }
  };
}

export function App() {
  const [form, setForm] = useState(initialForm);
  const [advance, setAdvance] = useState<PublicAdvance | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<"evaluate" | "fund" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const graphAge = useMemo(() => {
    if (!advance) return "Awaiting evaluation";
    const seconds = Math.max(
      0,
      Math.floor(Date.now() / 1000) - advance.market.indexedBlockTimestamp
    );
    return advance.market.evidenceType === "PRIVATE_VALUATION"
      ? `${Math.floor(seconds / 86_400)} days ago`
      : `${seconds}s ago`;
  }, [advance]);

  const privateCompany = form.asset === "WHOOP";
  const selectedAdvanceIsPrivate = advance?.market.evidenceType === "PRIVATE_VALUATION";

  function selectAsset(asset: AssetSymbol) {
    setForm({
      ...form,
      asset,
      units: asset === "WHOOP" ? "20000.0000" : "120.0000",
      strike: asset === "WHOOP" ? "1.20" : "0"
    });
    setAdvance(null);
    setToken(null);
    setError(null);
  }

  async function evaluate(event: React.FormEvent) {
    event.preventDefault();
    setBusy("evaluate");
    setError(null);
    try {
      const result = await evaluateAdvance(buildInput(form));
      setAdvance(result.advance);
      setToken(result.confirmationToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "EVALUATION_FAILED");
    } finally {
      setBusy(null);
    }
  }

  async function fund() {
    if (!advance || !token) return;
    setBusy("fund");
    setError(null);
    try {
      const result = await fundAdvance(advance.advanceId, token);
      setAdvance(result.advance);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "FUNDING_FAILED");
    } finally {
      setBusy(null);
    }
  }

  const fundingSimulated = advance?.funding?.simulated ?? false;
  const funded =
    advance?.state === "FUNDED" &&
    Boolean(advance.funding) &&
    (advance.funding?.consensusStatus === "SUCCESS" || fundingSimulated);
  const authorized = advance?.state === "AUTHORIZED";
  const verifiedCount = funded ? 4 : authorized ? 3 : advance ? 2 : 1;

  return (
    <div className="product-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="#overview" aria-label="unlockd.bond home">
          unlockd.bond
        </a>
        <Navigation />
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="mobile-brand-row">
            <a className="brand mobile-brand" href="#overview">
              unlockd.bond
            </a>
            <button
              aria-expanded={menuOpen}
              aria-label="Open menu"
              className="icon-button menu-button"
              onClick={() => setMenuOpen(true)}
              type="button"
            >
              <Menu aria-hidden="true" size={23} />
            </button>
          </div>
          <div className="breadcrumb">
            <span>Home</span>
            <span className="breadcrumb-separator">/</span>
            <strong>Advance workspace</strong>
          </div>
          <button aria-label="Notifications" className="icon-button" type="button">
            <Bell aria-hidden="true" size={21} strokeWidth={1.6} />
          </button>
        </header>

        {menuOpen ? (
          <div className="mobile-drawer" role="dialog" aria-modal="true" aria-label="Navigation">
            <button
              aria-label="Close menu"
              className="drawer-scrim"
              onClick={() => setMenuOpen(false)}
              type="button"
            />
            <aside>
              <div className="drawer-heading">
                <button
                  className="brand drawer-brand"
                  onClick={() => setMenuOpen(false)}
                  type="button"
                >
                  unlockd.bond
                </button>
                <button
                  aria-label="Close menu"
                  className="icon-button"
                  onClick={() => setMenuOpen(false)}
                  type="button"
                >
                  <X aria-hidden="true" size={22} />
                </button>
              </div>
              <Navigation onNavigate={() => setMenuOpen(false)} />
            </aside>
          </div>
        ) : null}

        <main className="content" id="overview">
          <section className="assistant-hero" aria-labelledby="workspace-title">
            <p className="eyebrow">Private, equity-aware salary advances</p>
            <h1 id="workspace-title">Unlock value from vested equity</h1>
            <p>
              Verify public or private-company equity evidence, assess repayment privately, and
              settle a bounded advance on Hedera Testnet.
            </p>
            <nav className="quick-actions" aria-label="Quick actions">
              <a href="#advance">
                <CircleDollarSign aria-hidden="true" size={18} />
                Request an advance
              </a>
              <a href="#evidence">
                <ShieldCheck aria-hidden="true" size={18} />
                Review evidence
              </a>
              <a href="#receipt">
                <ReceiptText aria-hidden="true" size={18} />
                View receipts
              </a>
            </nav>
          </section>

          <section className="dashboard-section" id="equity">
            <div className="section-heading">
              <div>
                <p className="section-kicker">Equity overview</p>
                <h2>Your vested position</h2>
              </div>
              <a href="#advance">Update details</a>
            </div>

            <fieldset className="asset-selector">
              <legend>Select equity example</legend>
              <button
                aria-pressed={!privateCompany}
                className={!privateCompany ? "is-selected" : ""}
                onClick={() => selectAsset("AAPL")}
                type="button"
              >
                <span>Public company</span>
                <strong>Apple · AAPL</strong>
              </button>
              <button
                aria-pressed={privateCompany}
                className={privateCompany ? "is-selected" : ""}
                onClick={() => selectAsset("WHOOP")}
                type="button"
              >
                <span>Private company</span>
                <strong>WHOOP · Pre-IPO</strong>
              </button>
            </fieldset>

            <div className="equity-grid">
              <article className="metric-card total-card">
                <span className="card-label">Eligible equity</span>
                <strong>{privateCompany ? "20,000" : "120"}</strong>
                <span className="metric-unit">
                  {privateCompany ? "vested options" : "vested RSUs"}
                </span>
                <div className="metric-status">
                  <TrendingUp aria-hidden="true" size={16} />
                  {privateCompany
                    ? "Synthetic private valuation available"
                    : "Public market evidence available"}
                </div>
              </article>

              <article className="metric-card company-card">
                <div className="company-mark">
                  {privateCompany ? (
                    <Building2 aria-label="WHOOP" size={28} strokeWidth={1.6} />
                  ) : (
                    <img alt="Apple" src="/assets/apple-logo.jpg" />
                  )}
                </div>
                <div>
                  <span className="card-label">
                    {privateCompany ? "WHOOP, Inc." : "Apple Inc."}
                  </span>
                  <strong>{form.asset}</strong>
                  <span>{privateCompany ? "Option · 20,000 vested" : "RSU · 120 vested"}</span>
                </div>
                <span className="eligibility-badge">
                  <Check aria-hidden="true" size={14} />
                  Eligible
                </span>
              </article>

              <article className="metric-card readiness-card">
                <span className="card-label">Funding readiness</span>
                <strong>{verifiedCount} of 4</strong>
                <div
                  aria-label={`${verifiedCount} of 4 checks complete`}
                  aria-valuemax={4}
                  aria-valuemin={0}
                  aria-valuenow={verifiedCount}
                  className="readiness-track"
                  role="progressbar"
                >
                  {["equity", "market", "risk", "funding"].map((key, index) => (
                    <span className={index < verifiedCount ? "complete" : ""} key={key} />
                  ))}
                </div>
                <a href="#advance">{advance ? "Continue review" : "Start evaluation"}</a>
              </article>
            </div>

            {privateCompany ? (
              <article className="private-model">
                <div>
                  <p className="section-kicker">How pre-IPO equity is assessed</p>
                  <h3>A bounded estimate without pretending WHOOP shares are tradable</h3>
                </div>
                <ol>
                  <li>
                    <span>1</span>
                    <div>
                      <strong>Verify the vested grant</strong>
                      <p>20,000 synthetic vested options; unvested units stay excluded.</p>
                    </div>
                  </li>
                  <li>
                    <span>2</span>
                    <div>
                      <strong>Use common-share evidence</strong>
                      <p>Synthetic 409A FMV of $4.80, less the $1.20 exercise price.</p>
                    </div>
                  </li>
                  <li>
                    <span>3</span>
                    <div>
                      <strong>Apply private-market controls</strong>
                      <p>60% illiquidity haircut plus a 10% policy buffer.</p>
                    </div>
                  </li>
                  <li>
                    <span>4</span>
                    <div>
                      <strong>Cap the credit line</strong>
                      <p>The lowest of equity, income, model, request, and fixed limits wins.</p>
                    </div>
                  </li>
                </ol>
                <p className="private-model-note">
                  WHOOP’s $10.1B Series G valuation is company-level context only—not an employee
                  common-share price. The shares remain restricted; this demo creates no transfer,
                  pledge, or lien.
                </p>
              </article>
            ) : null}
          </section>

          <div className="flow-grid">
            <form className="application panel" id="advance" onSubmit={evaluate}>
              <div className="panel-heading">
                <div>
                  <p className="section-kicker">Advance request</p>
                  <h2>Evaluate your request</h2>
                </div>
                <span className="private-badge">
                  <LockKeyhole aria-hidden="true" size={14} />
                  Private
                </span>
              </div>

              <p className="panel-copy">
                Your salary and grant inputs stay offchain. Only commitments and settlement receipts
                are public.
              </p>

              <div className="form-grid">
                <Field
                  help="Testnet account receiving the bounded payment."
                  inputMode="text"
                  label="Hedera account"
                  onChange={(value) =>
                    setForm({ ...form, account: `0.0.${value.replace(/\D/g, "")}` })
                  }
                  prefix="0.0"
                  value={form.account.replace(/^0\.0\./, "")}
                />
                <Field
                  help="Synthetic monthly take-home pay."
                  label="Monthly net income"
                  onChange={(value) => setForm({ ...form, income: value })}
                  prefix="USD"
                  value={form.income}
                />
                <Field
                  help="Vested units only; unvested units are excluded."
                  label={privateCompany ? "Vested WHOOP options" : "Vested AAPL RSUs"}
                  onChange={(value) => setForm({ ...form, units: value })}
                  prefix={form.asset}
                  value={form.units}
                />
                {privateCompany ? (
                  <Field
                    help="Synthetic option exercise price used for this example."
                    label="Exercise price"
                    onChange={(value) => setForm({ ...form, strike: value })}
                    prefix="USD"
                    value={form.strike}
                  />
                ) : null}
                <Field
                  help="Simulated amount you would like to access."
                  label="Requested amount"
                  onChange={(value) => setForm({ ...form, amount: value })}
                  prefix="USD"
                  value={form.amount}
                />
                <label className="field">
                  <span className="field-label">Term</span>
                  <span className="control">
                    <span className="control-prefix">Days</span>
                    <select
                      onChange={(event) =>
                        setForm({ ...form, term: event.target.value as FormState["term"] })
                      }
                      value={form.term}
                    >
                      <option value="14">14 days</option>
                      <option value="30">30 days</option>
                      <option value="45">45 days</option>
                    </select>
                  </span>
                  <span className="field-help">
                    Bounded testnet term; no repayment is collected.
                  </span>
                </label>
              </div>

              <div className="synthetic-notice">
                <ShieldCheck aria-hidden="true" size={20} />
                <div>
                  <strong>Synthetic profile · Test tokens only</strong>
                  <span>This experience creates no legal collateral.</span>
                </div>
                <em>Testnet</em>
              </div>

              {error ? (
                <div className="error" role="alert">
                  {error.replaceAll("_", " ")}
                </div>
              ) : null}

              <button className="primary" disabled={busy !== null} type="submit">
                <Sparkles aria-hidden="true" size={18} />
                {busy === "evaluate" ? "Evaluating privately…" : "Evaluate privately"}
              </button>
              <p className="privacy-footnote">
                Raw employee inputs are processed transiently and never written to public receipts.
              </p>
            </form>

            <aside className="evidence panel" id="evidence" aria-label="Evidence chain">
              <div className="panel-heading">
                <div>
                  <p className="section-kicker">Verification</p>
                  <h2>Evidence chain</h2>
                </div>
                <span className={`summary-status ${advance ? "is-ready" : ""}`}>
                  {advance ? "Evidence ready" : "Awaiting input"}
                </span>
              </div>

              <div className="evidence-list">
                <EvidenceStep
                  active={Boolean(advance)}
                  icon={TrendingUp}
                  rows={
                    selectedAdvanceIsPrivate
                      ? [
                          [
                            "Common FMV",
                            advance ? `${usd(advance.market.priceUsdMinor)} / share` : "—"
                          ],
                          ["Evidence age", graphAge],
                          ["Evidence bundle", advance?.market.subgraphDeployment ?? "—"]
                        ]
                      : [
                          [
                            "Graph block",
                            advance ? advance.market.indexedBlock.toLocaleString() : "—"
                          ],
                          ["Freshness", graphAge],
                          ["Deployment", advance?.market.subgraphDeployment ?? "—"]
                        ]
                  }
                  status={
                    advance ? (advance.market.simulated ? "Simulated" : "Verified") : "Waiting"
                  }
                  title={
                    selectedAdvanceIsPrivate ? "Private valuation evidence" : "Market evidence"
                  }
                />
                <EvidenceStep
                  active={Boolean(advance)}
                  icon={LockKeyhole}
                  rows={[
                    ["Trust mode", advance?.riskReceipt.trustMode ?? "—"],
                    ["Model", advance?.riskReceipt.model ?? "—"],
                    ["Policy cap", advance ? usd(advance.authorization.policyMaxMinor) : "—"]
                  ]}
                  status={
                    advance
                      ? advance.riskReceipt.teeVerified
                        ? "TEE verified"
                        : "Simulated"
                      : "Waiting"
                  }
                  title="Private risk"
                />
                <EvidenceStep
                  active={Boolean(advance)}
                  icon={Landmark}
                  rows={[
                    ["Hedera payment", funded ? "Consensus receipt" : "Pending confirmation"],
                    ["Advance Note", funded ? `#${advance.funding?.noteSerial}` : "Ready to mint"],
                    ["HCS record", funded ? `#${advance.funding?.hcsSequenceNumber}` : "Ready"]
                  ]}
                  status={
                    funded
                      ? fundingSimulated
                        ? "Simulated"
                        : "Consensus SUCCESS"
                      : advance
                        ? "Ready"
                        : "Waiting"
                  }
                  title="Bounded payment"
                />
              </div>

              {authorized ? (
                <section className="approval">
                  <div className="approval-heading">
                    <span className="approval-icon">
                      <Check aria-hidden="true" size={18} />
                    </span>
                    <div>
                      <span>
                        {selectedAdvanceIsPrivate
                          ? "Estimated testnet credit line"
                          : "Advance authorized"}
                      </span>
                      <strong>{usd(advance.authorization.amountMinor)}</strong>
                    </div>
                  </div>
                  <dl>
                    <div>
                      <dt>Term</dt>
                      <dd>{advance.termDays} days</dd>
                    </div>
                    <div>
                      <dt>Policy cap</dt>
                      <dd>{usd(advance.authorization.policyMaxMinor)}</dd>
                    </div>
                  </dl>
                  <button disabled={busy !== null} onClick={fund} type="button">
                    <Landmark aria-hidden="true" size={17} />
                    {busy === "fund" ? "Funding…" : "Fund test advance"}
                  </button>
                  <p>Preview only. Testnet tokens create no repayment obligation.</p>
                </section>
              ) : null}
            </aside>
          </div>

          <section className="receipt panel" id="receipt">
            <div className="panel-heading receipt-title">
              <div>
                <p className="section-kicker">Audit record</p>
                <h2>Proof receipt</h2>
              </div>
              <span className={`summary-status ${funded ? "is-ready" : ""}`}>
                {funded
                  ? fundingSimulated
                    ? "Simulated receipt"
                    : "Consensus SUCCESS"
                  : "Not generated"}
              </span>
            </div>

            {funded && advance.funding ? (
              <div className="receipt-layout">
                <dl className="receipt-data">
                  <div>
                    <dt>Payment transaction</dt>
                    <dd>
                      <a
                        href={advance.funding.hashscanTransactionUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {advance.funding.paymentTxId}
                        <ExternalLink aria-hidden="true" size={13} />
                      </a>
                    </dd>
                  </div>
                  <div>
                    <dt>NFT receipt</dt>
                    <dd>
                      <a href={advance.funding.hashscanTokenUrl} rel="noreferrer" target="_blank">
                        {advance.funding.noteTokenId}/{advance.funding.noteSerial}
                        <ExternalLink aria-hidden="true" size={13} />
                      </a>
                    </dd>
                  </div>
                  <div>
                    <dt>HCS topic</dt>
                    <dd>
                      <a href={advance.funding.hashscanTopicUrl} rel="noreferrer" target="_blank">
                        {advance.funding.hcsTopicId}
                        <ExternalLink aria-hidden="true" size={13} />
                      </a>
                    </dd>
                  </div>
                  <div>
                    <dt>Advance ID</dt>
                    <dd>{advance.advanceId}</dd>
                  </div>
                </dl>
                <div className="receipt-proof">
                  <FileCheck2 aria-hidden="true" size={28} />
                  <div>
                    <strong>A transaction ID alone is not settlement proof.</strong>
                    <p>
                      The receipt binds the payment, Advance Note, HCS record, and public
                      commitments.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="empty-receipt">
                <ReceiptText aria-hidden="true" size={26} />
                <div>
                  <strong>No receipt yet</strong>
                  <p>Evaluate and fund the test advance to create a verifiable record.</p>
                </div>
              </div>
            )}
          </section>

          <section className="trust-strip" aria-label="Privacy and environment disclosures">
            <div>
              <LockKeyhole aria-hidden="true" size={18} />
              <span>Private inputs stay offchain. Public receipts contain commitments only.</span>
            </div>
            <div>
              <Building2 aria-hidden="true" size={18} />
              <span>Synthetic profile · Test tokens only · Not legal collateral</span>
            </div>
          </section>
        </main>

        <footer>
          <span>unlockd.bond · Institutional testnet prototype</span>
          <span>Hedera Testnet · Synthetic data only</span>
        </footer>
      </div>
    </div>
  );
}
