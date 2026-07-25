import { useMemo, useState } from "react";
import type { PublicAdvance } from "../domain/public";
import type { AdvanceRequest } from "../domain/schemas";
import { evaluateAdvance, fundAdvance } from "./api";

type FormState = {
  account: string;
  income: string;
  units: string;
  amount: string;
  term: "14" | "30" | "45";
};

const initialForm: FormState = {
  account: "0.0.653284",
  income: "6500",
  units: "120.0000",
  amount: "1500",
  term: "30"
};

function Icon({ name }: { name: "shield" | "market" | "lock" | "ledger" | "check" }) {
  const paths = {
    shield: <path d="M12 3 5 6v5c0 4.6 2.8 7.9 7 10 4.2-2.1 7-5.4 7-10V6l-7-3Z" />,
    market: <path d="M4 18V6m0 12h16M7 14l4-4 3 2 5-6m0 0h-4m4 0v4" />,
    lock: (
      <>
        <rect x="5" y="10" width="14" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    ledger: (
      <>
        <path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h4" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      {paths[name]}
    </svg>
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
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode={inputMode}
          autoComplete="off"
          required
        />
      </span>
      <span className="field-help">{help}</span>
    </label>
  );
}

function EvidenceStep({
  number,
  icon,
  title,
  status,
  rows,
  active
}: {
  number: number;
  icon: "market" | "lock" | "ledger";
  title: string;
  status: string;
  rows: Array<[string, string]>;
  active: boolean;
}) {
  return (
    <section className={`evidence-step ${active ? "is-active" : ""}`}>
      <div className="step-number">{number}</div>
      <div className="evidence-body">
        <div className="evidence-heading">
          <span className="evidence-icon">
            <Icon name={icon} />
          </span>
          <h2>{title}</h2>
          <span className="status">{status}</span>
        </div>
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

const usd = (minor: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);

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
      assetSymbol: "AAPL",
      grantType: "RSU",
      vestedUnits: form.units,
      strikePriceMinor: 0,
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
  const graphAge = useMemo(() => {
    if (!advance) return "Awaiting evaluation";
    return `${Math.max(0, Math.floor(Date.now() / 1000) - advance.market.indexedBlockTimestamp)}s ago`;
  }, [advance]);

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

  const demo = advance?.mode !== "live";
  const funded = advance?.state === "FUNDED";
  return (
    <div className="app">
      <header>
        <a className="brand" href="/" aria-label="unlockd.bond home">
          unlockd.bond
        </a>
        <div className="header-meta">
          <a href="#receipt">Receipts</a>
          <span className="environment">
            <span />
            Testnet
          </span>
        </div>
      </header>

      <main>
        <form className="application" onSubmit={evaluate}>
          <div className="intro">
            <h1>Request an advance</h1>
            <p>Private inputs stay offchain. Public receipts contain commitments only.</p>
          </div>
          <Field
            label="Hedera account"
            prefix="0.0"
            value={form.account.replace(/^0\.0\./, "")}
            onChange={(value) => setForm({ ...form, account: `0.0.${value.replace(/\D/g, "")}` })}
            help="The public testnet account that receives the bounded payment."
            inputMode="text"
          />
          <Field
            label="Monthly net income"
            prefix="USD"
            value={form.income}
            onChange={(value) => setForm({ ...form, income: value })}
            help="Synthetic monthly take-home pay."
          />
          <Field
            label="Vested AAPL RSUs"
            prefix="AAPL"
            value={form.units}
            onChange={(value) => setForm({ ...form, units: value })}
            help="Vested units only. Unvested units are excluded."
          />
          <Field
            label="Requested amount"
            prefix="USD"
            value={form.amount}
            onChange={(value) => setForm({ ...form, amount: value })}
            help="The simulated amount you would like to access."
          />
          <label className="field">
            <span className="field-label">Term</span>
            <span className="control">
              <span className="control-prefix">Days</span>
              <select
                value={form.term}
                onChange={(event) =>
                  setForm({ ...form, term: event.target.value as FormState["term"] })
                }
              >
                <option value="14">14 days</option>
                <option value="30">30 days</option>
                <option value="45">45 days</option>
              </select>
            </span>
            <span className="field-help">
              Short, bounded testnet term. No repayment is collected.
            </span>
          </label>

          <div className="synthetic-notice">
            <Icon name="shield" />
            <div>
              <strong>Synthetic profile</strong>
              <span>Testnet data and test tokens only.</span>
            </div>
            <em>Not legal collateral</em>
          </div>
          {error && (
            <div className="error" role="alert">
              {error.replaceAll("_", " ")}
            </div>
          )}
          <button type="submit" className="primary" disabled={busy !== null}>
            <Icon name="lock" />
            {busy === "evaluate" ? "Evaluating…" : "Evaluate privately"}
          </button>
          <p className="privacy-footnote">
            Raw employee inputs are processed transiently and are never written to public receipts.
          </p>
        </form>

        <aside className="evidence" aria-label="Evidence chain">
          <p className="rail-label">Evidence chain</p>
          <div className="rail">
            <EvidenceStep
              number={1}
              icon="market"
              title="Market evidence"
              status={advance ? (demo ? "Simulated" : "Verified") : "Waiting"}
              active={Boolean(advance)}
              rows={[
                ["Graph block", advance ? advance.market.indexedBlock.toLocaleString() : "—"],
                ["Freshness", graphAge],
                ["Deployment", advance?.market.subgraphDeployment ?? "—"]
              ]}
            />
            <EvidenceStep
              number={2}
              icon="lock"
              title="Private risk"
              status={
                advance
                  ? advance.riskReceipt.teeVerified
                    ? "TEE verified"
                    : "Simulated"
                  : "Waiting"
              }
              active={Boolean(advance)}
              rows={[
                ["Trust mode", advance?.riskReceipt.trustMode ?? "—"],
                ["Model", advance?.riskReceipt.model ?? "—"],
                ["Policy cap", advance ? usd(advance.authorization.policyMaxMinor) : "—"]
              ]}
            />
            <EvidenceStep
              number={3}
              icon="ledger"
              title="Bounded payment"
              status={funded ? (demo ? "Simulated" : "Confirmed") : advance ? "Ready" : "Waiting"}
              active={Boolean(advance)}
              rows={[
                ["Hedera payment", funded ? "Consensus receipt" : "Pending confirmation"],
                ["Advance Note", funded ? `#${advance.funding?.noteSerial}` : "Ready to mint"],
                ["HCS record", funded ? `#${advance.funding?.hcsSequenceNumber}` : "Ready"]
              ]}
            />
          </div>

          {advance?.state === "AUTHORIZED" && (
            <section className="approval">
              <div>
                <span>Final safe amount</span>
                <strong>{usd(advance.authorization.amountMinor)}</strong>
              </div>
              <div>
                <span>Term</span>
                <strong>{advance.termDays} days</strong>
              </div>
              <button type="button" onClick={fund} disabled={busy !== null}>
                {busy === "fund" ? "Funding…" : "Fund test advance"}
              </button>
              <p>Preview only. Funding uses testnet tokens and creates no legal collateral.</p>
            </section>
          )}

          {funded && advance.funding && (
            <section className="receipt" id="receipt">
              <div className="receipt-heading">
                <div>
                  <span>Proof receipt</span>
                  <h2>{demo ? "Simulated demo" : "Consensus confirmed"}</h2>
                </div>
                <Icon name="check" />
              </div>
              <dl>
                <div>
                  <dt>Payment tx</dt>
                  <dd>
                    <a href={advance.funding.mirrorTransactionUrl} target="_blank" rel="noreferrer">
                      {advance.funding.paymentTxId}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>NFT receipt</dt>
                  <dd>
                    <a href={advance.funding.mirrorTokenUrl} target="_blank" rel="noreferrer">
                      {advance.funding.noteTokenId}/{advance.funding.noteSerial}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>HCS topic</dt>
                  <dd>{advance.funding.hcsTopicId}</dd>
                </div>
                <div>
                  <dt>Advance ID</dt>
                  <dd>{advance.advanceId}</dd>
                </div>
              </dl>
              <p>
                {demo
                  ? "Simulation only. These identifiers are not partner proof."
                  : "Verified through Hedera Testnet consensus and public Mirror Node records."}
              </p>
            </section>
          )}
        </aside>
      </main>
      <footer>
        <span>Testnet environment — synthetic data and test tokens only.</span>
        <span>unlockd.bond v1.0</span>
      </footer>
    </div>
  );
}
