import type { LucideIcon } from "lucide-react";
import {
  Bell,
  Building2,
  Check,
  ChevronDown,
  CircleDollarSign,
  ExternalLink,
  FileCheck2,
  FileUp,
  Landmark,
  LockKeyhole,
  Menu,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UserRoundCheck,
  WalletCards,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CustomerAdvance } from "../domain/public";
import type {
  AdvanceRequest,
  AssetSymbol,
  FundingResult,
  FundingResultV2,
  PrivateCompanyListing
} from "../domain/schemas";
import { evaluateAdvance, fundAdvance, getPrivateCompanies } from "./api";

type FormState = {
  asset: AssetSymbol;
  companyIdentifier: string;
  units: string;
  strike: string;
  sharePrice: string;
  valuationDate: string;
  amount: string;
  term: "14" | "30" | "45";
};

const daysAgoIso = (days: number) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const initialForm: FormState = {
  asset: "WHOO.PVT",
  companyIdentifier: "WHOO.PVT",
  units: "20000.0000",
  strike: "0",
  // The server replaces these schema placeholders with fresh Yahoo evidence.
  sharePrice: "7.30",
  valuationDate: daysAgoIso(0),
  amount: "1500",
  term: "30"
};

function isFundingResultV2(funding: FundingResult): funding is FundingResultV2 {
  return "version" in funding && funding.version === 2;
}

const navItems: Array<{ label: string; href: string; icon: LucideIcon }> = [
  { label: "Equity", href: "#equity", icon: WalletCards },
  { label: "Advance", href: "#advance", icon: CircleDollarSign },
  { label: "Receipts", href: "#receipt", icon: ReceiptText }
];

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const [activeHash, setActiveHash] = useState(() => window.location.hash || "#equity");

  useEffect(() => {
    const updateHash = () => setActiveHash(window.location.hash || "#equity");
    window.addEventListener("hashchange", updateHash);
    return () => window.removeEventListener("hashchange", updateHash);
  }, []);

  return (
    <>
      <nav className="primary-nav" aria-label="Main navigation">
        {navItems.map(({ label, href, icon: NavIcon }) => (
          <a
            className={activeHash === href ? "is-current" : ""}
            href={href}
            key={label}
            onClick={() => {
              setActiveHash(href);
              onNavigate?.();
            }}
          >
            <NavIcon aria-hidden="true" size={20} strokeWidth={1.7} />
            <span>{label}</span>
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

function JourneySteps({ stage, companyName }: { stage: number; companyName: string }) {
  const steps = [
    ["Company", `Select ${companyName}`],
    ["RSU grant", "Record vested units"],
    ["Vesting", "Review the schedule"],
    ["KYC", "Verify identity"],
    ["Advance", "Price and authorize"],
    ["Receipt", "Hedera settlement proof"]
  ];

  return (
    <nav aria-label="Private equity advance journey" className="journey-steps">
      {steps.map(([title, detail], index) => {
        const number = index + 1;
        const complete = number < stage;
        const current = number === stage;
        return (
          <div className={complete ? "is-complete" : current ? "is-current" : ""} key={title}>
            <span aria-hidden="true">
              {complete ? <Check size={14} strokeWidth={2.4} /> : number}
            </span>
            <div>
              <strong>{title}</strong>
              <small>{detail}</small>
            </div>
          </div>
        );
      })}
    </nav>
  );
}

const usd = (minor: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(minor / 100);

const usdPrecise = (minor: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(minor / 100);

function buildInput(form: FormState): AdvanceRequest {
  const id = crypto.randomUUID().replaceAll("-", "");
  return {
    requestId: `ub_req_${id}`,
    employeeRef: `ub_emp_${crypto.randomUUID().replaceAll("-", "")}`,
    synthetic: true,
    grant: {
      assetSymbol: form.asset,
      companyIdentifier: form.companyIdentifier,
      grantType: "RSU",
      vestedUnits: form.units,
      strikePriceMinor: 0,
      referenceSharePriceMinor: form.asset.endsWith(".PVT")
        ? Math.round(Number(form.sharePrice) * 100)
        : null,
      valuationDate: form.asset.endsWith(".PVT") ? form.valuationDate : null,
      valuationSource: form.asset.endsWith(".PVT") ? "SYNTHETIC" : null,
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
  const [profileStep, setProfileStep] = useState<1 | 2 | 3 | 4>(1);
  const [profileComplete, setProfileComplete] = useState(false);
  const [vestingPreset, setVestingPreset] = useState<
    "48_MONTHS_CLIFF" | "48_MONTHS_NO_CLIFF" | "CUSTOM"
  >("48_MONTHS_CLIFF");
  const [vestingStart, setVestingStart] = useState("2023-01-15");
  const [vestingFrequency, setVestingFrequency] = useState("Quarterly");
  const [advance, setAdvance] = useState<CustomerAdvance | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<"evaluate" | "fund" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [privateCompanies, setPrivateCompanies] = useState<PrivateCompanyListing[]>([]);
  const [privatePriceLoading, setPrivatePriceLoading] = useState(false);
  const [kycApproved, setKycApproved] = useState(false);
  const [documentsApproved, setDocumentsApproved] = useState(false);

  const selectedCompany = useMemo(
    () => privateCompanies.find((company) => company.ticker === form.asset) ?? null,
    [form.asset, privateCompanies]
  );
  const grossEquityValueMinor = useMemo(
    () =>
      Math.max(
        0,
        Math.floor(
          Number(form.units || 0) *
            (selectedCompany?.priceUsdMinor ?? Number(form.sharePrice) * 100)
        )
      ),
    [form.sharePrice, form.units, selectedCompany]
  );
  const maxBorrowMinor = Math.floor(grossEquityValueMinor * 0.7);

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

  const privateCompany = form.asset.endsWith(".PVT");
  const selectedAdvanceIsPrivate = advance?.market.evidenceType === "PRIVATE_VALUATION";

  useEffect(() => {
    let cancelled = false;
    setPrivatePriceLoading(true);
    void getPrivateCompanies()
      .then((companies) => {
        if (cancelled) return;
        setPrivateCompanies(companies);
        setForm((current) => {
          const preferred =
            companies.find((company) => company.ticker === current.asset) ??
            companies.find((company) => company.ticker === "WHOO.PVT") ??
            companies[0];
          return preferred
            ? {
                ...current,
                asset: preferred.ticker,
                companyIdentifier: preferred.ticker,
                sharePrice: (preferred.priceUsdMinor / 100).toFixed(2),
                valuationDate: new Date(preferred.priceUpdatedAt * 1000).toISOString().slice(0, 10)
              }
            : current;
        });
      })
      .catch(() => {
        if (!cancelled) setPrivateCompanies([]);
      })
      .finally(() => {
        if (!cancelled) setPrivatePriceLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (maxBorrowMinor <= 0) return;
    const requestedMinor = Math.round(Number(form.amount || 0) * 100);
    if (requestedMinor > maxBorrowMinor) {
      setForm((current) => ({
        ...current,
        amount: (maxBorrowMinor / 100).toFixed(0)
      }));
      setAdvance(null);
      setToken(null);
      setError(null);
    }
  }, [maxBorrowMinor, form.amount]);

  function alignProfile() {
    const frame = requestAnimationFrame(() => {
      const profile = document.querySelector(".profile-flow");
      if (!profile) return;
      const top = profile.getBoundingClientRect().top + window.scrollY - 104;
      window.scrollTo({ top, behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }

  function resetEvaluation() {
    setAdvance(null);
    setToken(null);
    setError(null);
  }

  function editProfile() {
    resetEvaluation();
    setProfileComplete(false);
    setProfileStep(1);
    alignProfile();
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
  const fundingV2 = advance?.funding && isFundingResultV2(advance.funding) ? advance.funding : null;
  const legacyFunding =
    advance?.funding && !isFundingResultV2(advance.funding) ? advance.funding : null;
  const fundingConsensusSuccess = fundingV2
    ? Object.values(fundingV2.transactions).every(
        (transaction) => transaction.consensusStatus === "SUCCESS"
      )
    : legacyFunding?.consensusStatus === "SUCCESS";
  const noteSerial = fundingV2?.note.serial ?? legacyFunding?.noteSerial ?? "—";
  const fundedSequenceNumber =
    fundingV2?.topic.fundedSequenceNumber ?? legacyFunding?.hcsSequenceNumber ?? "—";
  const funded =
    advance?.state === "FUNDED" &&
    Boolean(advance.funding) &&
    (fundingConsensusSuccess || fundingSimulated);
  const authorized = advance?.state === "AUTHORIZED";
  const verifiedCount = funded ? 5 : authorized ? 4 : advance ? 3 : profileComplete ? 2 : 0;
  const journeyStage = funded ? 6 : profileComplete ? 5 : profileStep;
  const selectedCompanyName = selectedCompany?.companyName ?? "private company";

  return (
    <div className="product-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="#equity" aria-label="unlockd.bond equity workspace">
          unlockd.bond
        </a>
        <Navigation />
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="mobile-brand-row">
            <a className="brand mobile-brand" href="#equity">
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
            <span>Equity</span>
            <span className="breadcrumb-separator">/</span>
            <strong>{selectedCompanyName} RSU workspace</strong>
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
            <p className="eyebrow">Private-company equity liquidity</p>
            <h1 id="workspace-title">Turn vested private-company RSUs into liquidity</h1>
            <p>
              Select a Yahoo-listed private company, verify your vested shares, and request up to
              70% of their estimated value.
            </p>
            <nav className="quick-actions" aria-label="Quick actions">
              <a href="#equity">
                <WalletCards aria-hidden="true" size={18} />
                Build equity profile
              </a>
              <a href="#advance">
                <CircleDollarSign aria-hidden="true" size={18} />
                Review advance
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
                <p className="section-kicker">Private company</p>
                <h2>{selectedCompanyName} equity profile</h2>
              </div>
              {profileComplete ? (
                <button className="section-link" onClick={editProfile} type="button">
                  Edit profile
                </button>
              ) : (
                <span className="section-meta">Synthetic RSU holder</span>
              )}
            </div>

            <article className="profile-flow" aria-label="Private-company equity profile flow">
              <nav aria-label="Equity profile progress" className="profile-progress">
                {[
                  ["Company", "Yahoo private company"],
                  ["RSU grant", "Vested units"],
                  ["Vesting", "Schedule details"],
                  ["KYC", "Identity & documents"]
                ].map(([title, detail], index) => {
                  const number = index + 1;
                  const complete = profileComplete || number < profileStep;
                  const current = !profileComplete && number === profileStep;
                  return (
                    <button
                      aria-current={current ? "step" : undefined}
                      className={complete ? "is-complete" : current ? "is-current" : ""}
                      disabled={!complete && !current}
                      key={title}
                      onClick={(event) => {
                        event.currentTarget.blur();
                        if (complete) {
                          setProfileComplete(false);
                          setProfileStep(number as 1 | 2 | 3 | 4);
                          alignProfile();
                        }
                      }}
                      type="button"
                    >
                      <span>{complete ? <Check size={14} /> : number}</span>
                      <div>
                        <strong>{title}</strong>
                        <small>{detail}</small>
                      </div>
                    </button>
                  );
                })}
              </nav>

              {profileComplete ? (
                <div className="profile-complete">
                  <span className="profile-complete-icon">
                    <Check aria-hidden="true" size={22} />
                  </span>
                  <div>
                    <p className="section-kicker">Profile complete</p>
                    <h3>{selectedCompanyName} RSU position is ready for review</h3>
                    <p>
                      {Number(form.units).toLocaleString()} vested RSUs ·{" "}
                      {vestingPreset === "48_MONTHS_CLIFF"
                        ? "48 months with 1-year cliff"
                        : vestingPreset === "48_MONTHS_NO_CLIFF"
                          ? "48 months with no cliff"
                          : "Custom vesting schedule"}{" "}
                      · {vestingFrequency.toLowerCase()}
                    </p>
                  </div>
                  <a href="#advance">Continue to advance</a>
                </div>
              ) : (
                <div className="profile-stage">
                  {profileStep === 1 ? (
                    <>
                      <div className="profile-stage-copy">
                        <p className="section-kicker">Step 1 of 4</p>
                        <h3>Select your private company</h3>
                        <p>
                          Choose from Yahoo Finance’s private-company market table. The listed
                          reference price drives the equity valuation.
                        </p>
                      </div>
                      <label className="company-select">
                        <span className="field-label">Private company</span>
                        <select
                          disabled={privatePriceLoading || privateCompanies.length === 0}
                          onChange={(event) => {
                            const company = privateCompanies.find(
                              (candidate) => candidate.ticker === event.target.value
                            );
                            if (!company) return;
                            setForm({
                              ...form,
                              asset: company.ticker,
                              companyIdentifier: company.ticker,
                              sharePrice: (company.priceUsdMinor / 100).toFixed(2),
                              valuationDate: new Date(company.priceUpdatedAt * 1000)
                                .toISOString()
                                .slice(0, 10)
                            });
                            resetEvaluation();
                          }}
                          value={form.asset}
                        >
                          {privateCompanies.map((company) => (
                            <option key={company.ticker} value={company.ticker}>
                              {company.companyName} · {company.ticker}
                            </option>
                          ))}
                        </select>
                        <span className="field-help">
                          {privatePriceLoading
                            ? "Loading the Yahoo private-company catalogue…"
                            : `${privateCompanies.length} companies available from live or cached Yahoo evidence.`}
                        </span>
                      </label>
                      <div className="company-result">
                        <span className="company-result-mark">
                          {form.asset === "WHOO.PVT" ? (
                            <img alt="" src="/assets/whoop-logo.png" />
                          ) : (
                            <Building2 aria-hidden="true" size={24} />
                          )}
                        </span>
                        <div>
                          <strong>{selectedCompanyName}</strong>
                          <span>
                            {selectedCompany?.sector ?? "Private company"} ·{" "}
                            {selectedCompany?.latestShareClass ?? "Share class not reported"}
                          </span>
                        </div>
                        <span className="verified-label">
                          <Check aria-hidden="true" size={13} />
                          Selected
                        </span>
                      </div>
                      <div className="profile-fields">
                        <div className="field">
                          <span className="field-label">Private-market price</span>
                          <span className="control">
                            <span className="control-prefix">Yahoo</span>
                            <input
                              aria-label="Yahoo private-market price"
                              readOnly
                              value={
                                privatePriceLoading
                                  ? "Loading…"
                                  : selectedCompany
                                    ? `${usdPrecise(selectedCompany.priceUsdMinor)} / share`
                                    : "Unavailable"
                              }
                            />
                          </span>
                          <span className="field-help">
                            {selectedCompany
                              ? `${selectedCompany.ticker} · ${selectedCompany.cacheStatus} Yahoo evidence`
                              : "Live or cached evidence is required before evaluation."}
                          </span>
                        </div>
                        <div className="field">
                          <span className="field-label">Estimated company valuation</span>
                          <span className="control">
                            <span className="control-prefix">Yahoo</span>
                            <input
                              aria-label="Estimated company valuation"
                              readOnly
                              value={
                                selectedCompany?.estimatedValuationUsdMinor
                                  ? usd(selectedCompany.estimatedValuationUsdMinor)
                                  : "Not reported"
                              }
                            />
                          </span>
                          <span className="field-help">
                            Reference context only; the advance uses per-share price.
                          </span>
                        </div>
                      </div>
                    </>
                  ) : null}

                  {profileStep === 2 ? (
                    <>
                      <div className="profile-stage-copy">
                        <p className="section-kicker">Step 2 of 4</p>
                        <h3>Add your vested RSU grant</h3>
                        <p>
                          Only vested units are eligible. Unvested equity remains outside the
                          advance calculation.
                        </p>
                      </div>
                      <div className="grant-type-card is-selected">
                        <span className="grant-type-icon">
                          <WalletCards aria-hidden="true" size={23} />
                        </span>
                        <div>
                          <strong>Restricted Stock Units (RSUs)</strong>
                          <span>No exercise price · transfer restricted</span>
                        </div>
                        <span className="verified-label">
                          <Check aria-hidden="true" size={13} />
                          Selected
                        </span>
                      </div>
                      <div className="profile-fields single">
                        <Field
                          help="Synthetic vested units used in the hackathon demonstration."
                          label={`Vested ${selectedCompanyName} RSUs`}
                          onChange={(value) => {
                            setForm({ ...form, units: value });
                            resetEvaluation();
                          }}
                          prefix={form.asset.replace(".PVT", "")}
                          value={form.units}
                        />
                      </div>
                    </>
                  ) : null}

                  {profileStep === 3 ? (
                    <>
                      <div className="profile-stage-copy">
                        <p className="section-kicker">Step 3 of 4</p>
                        <h3>Review your vesting schedule</h3>
                        <p>
                          Vesting details help explain the position. Only the vested-unit total is
                          used for pricing or included in the private commitment.
                        </p>
                      </div>
                      <fieldset className="vesting-options">
                        <legend>Vesting schedule</legend>
                        {[
                          ["48_MONTHS_CLIFF", "48 months", "1-year cliff"],
                          ["48_MONTHS_NO_CLIFF", "48 months", "No cliff"],
                          ["CUSTOM", "Custom", "Manual schedule"]
                        ].map(([value, title, detail]) => (
                          <button
                            aria-pressed={vestingPreset === value}
                            className={vestingPreset === value ? "is-selected" : ""}
                            key={value}
                            onClick={() =>
                              setVestingPreset(
                                value as "48_MONTHS_CLIFF" | "48_MONTHS_NO_CLIFF" | "CUSTOM"
                              )
                            }
                            type="button"
                          >
                            <strong>{title}</strong>
                            <span>{detail}</span>
                          </button>
                        ))}
                      </fieldset>
                      <div className="profile-fields">
                        <label className="field">
                          <span className="field-label">Vesting start date</span>
                          <span className="control">
                            <span className="control-prefix">Date</span>
                            <input
                              onChange={(event) => setVestingStart(event.target.value)}
                              type="date"
                              value={vestingStart}
                            />
                          </span>
                          <span className="field-help">
                            Synthetic schedule for the demo profile.
                          </span>
                        </label>
                        <label className="field">
                          <span className="field-label">Vesting frequency</span>
                          <span className="control">
                            <span className="control-prefix">Cycle</span>
                            <select
                              onChange={(event) => setVestingFrequency(event.target.value)}
                              value={vestingFrequency}
                            >
                              <option>Monthly</option>
                              <option>Quarterly</option>
                              <option>Annually</option>
                            </select>
                          </span>
                          <span className="field-help">
                            Descriptive only; it does not trigger a Hedera transaction.
                          </span>
                        </label>
                      </div>
                    </>
                  ) : null}

                  {profileStep === 4 ? (
                    <>
                      <div className="profile-stage-copy">
                        <p className="section-kicker">Step 4 of 4</p>
                        <h3>Verify identity and equity evidence</h3>
                        <p>
                          For this hackathon MVP, both checks use deterministic demo approval.
                          Production would connect an identity provider and encrypted document
                          review.
                        </p>
                      </div>
                      <div className="verification-grid">
                        <article className={kycApproved ? "is-approved" : ""}>
                          <span>
                            <UserRoundCheck aria-hidden="true" size={22} />
                          </span>
                          <div>
                            <strong>Identity verification</strong>
                            <small>Demo KYC · name and identity check</small>
                          </div>
                          <button
                            onClick={() => {
                              setKycApproved(true);
                              resetEvaluation();
                            }}
                            type="button"
                          >
                            {kycApproved ? (
                              <>
                                <Check aria-hidden="true" size={14} /> Approved
                              </>
                            ) : (
                              "Conduct KYC"
                            )}
                          </button>
                        </article>
                        <article className={documentsApproved ? "is-approved" : ""}>
                          <span>
                            <FileUp aria-hidden="true" size={22} />
                          </span>
                          <div>
                            <strong>Equity documents</strong>
                            <small>RSU statement and vesting evidence</small>
                          </div>
                          <button
                            onClick={() => {
                              setDocumentsApproved(true);
                              resetEvaluation();
                            }}
                            type="button"
                          >
                            {documentsApproved ? (
                              <>
                                <Check aria-hidden="true" size={14} /> Approved
                              </>
                            ) : (
                              "Upload documents"
                            )}
                          </button>
                        </article>
                      </div>
                      <div className="demo-disclosure">
                        <ShieldCheck aria-hidden="true" size={18} />
                        <span>
                          Demo behavior: clicking either button immediately returns a successful
                          approval. No personal document is uploaded or stored.
                        </span>
                      </div>
                    </>
                  ) : null}

                  <div className="profile-actions">
                    <button
                      className="secondary"
                      disabled={profileStep === 1}
                      onClick={(event) => {
                        event.currentTarget.blur();
                        setProfileStep((profileStep - 1) as 1 | 2 | 3);
                        alignProfile();
                      }}
                      type="button"
                    >
                      Back
                    </button>
                    <button
                      className="primary"
                      disabled={
                        (profileStep === 1 &&
                          (privatePriceLoading || privateCompanies.length === 0)) ||
                        (profileStep === 4 && (!kycApproved || !documentsApproved))
                      }
                      onClick={(event) => {
                        event.currentTarget.blur();
                        if (profileStep < 4) {
                          setProfileStep((profileStep + 1) as 2 | 3 | 4);
                        } else {
                          setProfileComplete(true);
                        }
                        alignProfile();
                      }}
                      type="button"
                    >
                      {profileStep === 1
                        ? "Continue to RSU grant"
                        : profileStep === 2
                          ? "Continue to vesting"
                          : profileStep === 3
                            ? "Continue to verification"
                            : "Complete equity profile"}
                    </button>
                  </div>
                </div>
              )}
            </article>

            <div className="equity-grid">
              <article className="metric-card total-card">
                <span className="card-label">Eligible equity</span>
                <strong>{Number(form.units).toLocaleString()}</strong>
                <span className="metric-unit">vested RSUs</span>
                <div className="metric-status">
                  <TrendingUp aria-hidden="true" size={16} />
                  Yahoo private-market price available
                </div>
              </article>

              <article className="metric-card company-card">
                <div className="company-mark">
                  {form.asset === "WHOO.PVT" ? (
                    <img alt="WHOOP" src="/assets/whoop-logo.png" />
                  ) : (
                    <Building2 aria-hidden="true" size={27} />
                  )}
                </div>
                <div>
                  <span className="card-label">{selectedCompanyName}</span>
                  <strong>{form.asset}</strong>
                  <span>RSU · {Number(form.units).toLocaleString()} vested</span>
                </div>
                <span className="eligibility-badge">
                  <Check aria-hidden="true" size={14} />
                  Eligible
                </span>
              </article>

              <article className="metric-card readiness-card">
                <span className="card-label">Funding readiness</span>
                <strong>{verifiedCount} of 5</strong>
                <div
                  aria-label={`${verifiedCount} of 5 checks complete`}
                  aria-valuemax={5}
                  aria-valuemin={0}
                  aria-valuenow={verifiedCount}
                  className="readiness-track"
                  role="progressbar"
                >
                  {["equity", "kyc", "market", "risk", "funding"].map((key, index) => (
                    <span className={index < verifiedCount ? "complete" : ""} key={key} />
                  ))}
                </div>
                <a href="#advance">{advance ? "Continue review" : "Start evaluation"}</a>
              </article>
            </div>
          </section>

          {privateCompany ? (
            <JourneySteps companyName={selectedCompanyName} stage={journeyStage} />
          ) : null}

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
                Your request is limited to 70% of the estimated value of vested shares. Evaluation
                creates indicative terms only; no Hedera transaction occurs until you explicitly
                fund.
              </p>

              <div className="form-grid">
                <div className="loan-slider">
                  <div className="loan-slider-heading">
                    <div>
                      <span className="field-label">Requested loan amount</span>
                      <strong>{usd(Math.round(Number(form.amount || 0) * 100))}</strong>
                    </div>
                    <span>
                      Maximum available
                      <strong>{usd(maxBorrowMinor)}</strong>
                    </span>
                  </div>
                  <input
                    aria-label="Requested loan amount"
                    max={Math.max(100, Math.floor(maxBorrowMinor / 100))}
                    min="100"
                    onChange={(event) => {
                      setForm({ ...form, amount: event.target.value });
                      resetEvaluation();
                    }}
                    step="100"
                    type="range"
                    value={Math.min(
                      Math.max(100, Math.floor(maxBorrowMinor / 100)),
                      Math.max(100, Number(form.amount || 100))
                    )}
                  />
                  <div className="loan-slider-scale">
                    <span>$100</span>
                    <span>70% LTV of {usd(grossEquityValueMinor)} vested equity</span>
                  </div>
                </div>
                <label className="field">
                  <span className="field-label">Term</span>
                  <span className="control">
                    <span className="control-prefix">Days</span>
                    <select
                      onChange={(event) => {
                        setForm({
                          ...form,
                          term: event.target.value as FormState["term"]
                        });
                        resetEvaluation();
                      }}
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
                  <strong>
                    {profileComplete ? "Equity profile complete" : "Complete your equity profile"}
                  </strong>
                  <span>
                    {profileComplete
                      ? `${selectedCompanyName} RSU and verification inputs are ready for private evaluation.`
                      : "Company, grant, vesting, KYC, and document checks are required first."}
                  </span>
                </div>
                <em>{profileComplete ? "Ready" : "Required"}</em>
              </div>

              {error ? (
                <div className="error" role="alert">
                  {error.replaceAll("_", " ")}
                </div>
              ) : null}

              <button
                className="primary"
                disabled={busy !== null || !profileComplete}
                type="submit"
              >
                <Sparkles aria-hidden="true" size={18} />
                {busy === "evaluate"
                  ? "Evaluating privately…"
                  : profileComplete
                    ? "Evaluate privately"
                    : "Complete equity profile first"}
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
                            "Yahoo price",
                            advance ? `${usdPrecise(advance.market.priceUsdMinor)} / share` : "—"
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
                    [
                      "Hedera payment",
                      funded && fundingV2
                        ? `${(fundingV2.asset.amountMinor / 100).toFixed(2)} USDC`
                        : funded
                          ? "Consensus receipt"
                          : "Pending confirmation"
                    ],
                    ["Advance Note", funded ? `#${noteSerial}` : "Ready to mint"],
                    ["HCS record", funded ? `#${fundedSequenceNumber}` : "Ready"]
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

              {advance?.pricing ? (
                <section className="valuation-breakdown" aria-labelledby="valuation-title">
                  <div className="valuation-heading">
                    <div>
                      <span className="section-kicker">Equity pricing</span>
                      <h3 id="valuation-title">Your valuation breakdown</h3>
                    </div>
                    <span className="pricing-source">
                      {advance.pricing.valuationSource === "YAHOO_PRIVATE_MARKET"
                        ? `Yahoo Finance · ${advance.market.assetSymbol}`
                        : advance.pricing.companyRiskSource === "coresignal"
                          ? `Coresignal · ${advance.pricing.cacheStatus}`
                          : "Conservative fallback"}
                    </span>
                  </div>
                  <dl>
                    <div>
                      <dt>Reference share price</dt>
                      <dd>{usdPrecise(advance.pricing.referenceSharePriceMinor)}</dd>
                    </div>
                    {advance.pricing.strikePriceMinor > 0 ? (
                      <>
                        <div>
                          <dt>Exercise price</dt>
                          <dd>{usdPrecise(advance.pricing.strikePriceMinor)}</dd>
                        </div>
                        <div>
                          <dt>Net value per option</dt>
                          <dd>{usdPrecise(advance.pricing.netValuePerOptionMinor)}</dd>
                        </div>
                      </>
                    ) : (
                      <div>
                        <dt>Vested RSU value per share</dt>
                        <dd>{usdPrecise(advance.pricing.netValuePerOptionMinor)}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Gross vested value</dt>
                      <dd>{usd(advance.pricing.grossEquityValueMinor)}</dd>
                    </div>
                    <div>
                      <dt>Vested equity value</dt>
                      <dd>{usd(advance.pricing.eligibleEquityValueMinor)}</dd>
                    </div>
                    <div>
                      <dt>Maximum borrow · 70% LTV</dt>
                      <dd>{usd(advance.pricing.equityBasedCreditLimitMinor)}</dd>
                    </div>
                    <div>
                      <dt>Requested amount</dt>
                      <dd>{usd(Math.round(Number(form.amount) * 100))}</dd>
                    </div>
                  </dl>
                  <p>
                    Maximum borrow is calculated only from vested shares and the Yahoo per-share
                    reference price. Compensation data is not collected or used.
                  </p>
                </section>
              ) : null}

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
                  <p>Demo USDC — no real value. Testnet tokens create no repayment obligation.</p>
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
                {fundingV2 ? (
                  <dl className="receipt-data">
                    <div>
                      <dt>Payout</dt>
                      <dd>
                        {(fundingV2.asset.amountMinor / 100).toFixed(2)} USDC
                        <span className="demo-token-label">Demo Testnet Token</span>
                      </dd>
                    </div>
                    {(
                      [
                        ["Authorization HCS", fundingV2.transactions.authorization],
                        ["Advance Note mint", fundingV2.transactions.noteMint],
                        ["Atomic settlement", fundingV2.transactions.settlement],
                        ["Funded HCS", fundingV2.transactions.fundedEvent]
                      ] as const
                    ).map(([label, transaction]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>
                          {fundingV2.simulated ? (
                            transaction.transactionId
                          ) : (
                            <a href={transaction.hashscanUrl} rel="noreferrer" target="_blank">
                              {transaction.transactionId}
                              <ExternalLink aria-hidden="true" size={13} />
                            </a>
                          )}
                        </dd>
                      </div>
                    ))}
                    <div>
                      <dt>USDC DEMO token</dt>
                      <dd>
                        {fundingV2.simulated ? (
                          fundingV2.asset.tokenId
                        ) : (
                          <a href={fundingV2.asset.hashscanUrl} rel="noreferrer" target="_blank">
                            {fundingV2.asset.tokenId}
                            <ExternalLink aria-hidden="true" size={13} />
                          </a>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>NFT receipt</dt>
                      <dd>
                        {fundingV2.simulated ? (
                          `${fundingV2.note.tokenId}/${fundingV2.note.serial}`
                        ) : (
                          <a href={fundingV2.note.hashscanUrl} rel="noreferrer" target="_blank">
                            {fundingV2.note.tokenId}/{fundingV2.note.serial}
                            <ExternalLink aria-hidden="true" size={13} />
                          </a>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>HCS topic</dt>
                      <dd>
                        {fundingV2.simulated ? (
                          fundingV2.topic.topicId
                        ) : (
                          <a href={fundingV2.topic.hashscanUrl} rel="noreferrer" target="_blank">
                            {fundingV2.topic.topicId}
                            <ExternalLink aria-hidden="true" size={13} />
                          </a>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Advance ID</dt>
                      <dd>{advance.advanceId}</dd>
                    </div>
                  </dl>
                ) : legacyFunding ? (
                  <dl className="receipt-data">
                    <div>
                      <dt>Payment transaction</dt>
                      <dd>
                        <a
                          href={legacyFunding.hashscanTransactionUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {legacyFunding.paymentTxId}
                          <ExternalLink aria-hidden="true" size={13} />
                        </a>
                      </dd>
                    </div>
                    <div>
                      <dt>NFT receipt</dt>
                      <dd>
                        <a href={legacyFunding.hashscanTokenUrl} rel="noreferrer" target="_blank">
                          {legacyFunding.noteTokenId}/{legacyFunding.noteSerial}
                          <ExternalLink aria-hidden="true" size={13} />
                        </a>
                      </dd>
                    </div>
                    <div>
                      <dt>HCS topic</dt>
                      <dd>
                        <a href={legacyFunding.hashscanTopicUrl} rel="noreferrer" target="_blank">
                          {legacyFunding.hcsTopicId}
                          <ExternalLink aria-hidden="true" size={13} />
                        </a>
                      </dd>
                    </div>
                    <div>
                      <dt>Advance ID</dt>
                      <dd>{advance.advanceId}</dd>
                    </div>
                  </dl>
                ) : null}
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
              <span>Synthetic profile · Demo USDC has no real value · Not legal collateral</span>
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
