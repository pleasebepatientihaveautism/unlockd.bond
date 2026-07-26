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
import { evaluateAdvance, fundAdvance, getPrivateCompanies, repayAdvance } from "./api";

type FormState = {
  asset: AssetSymbol;
  companyIdentifier: string;
  grantType: "OPTION" | "RSU";
  units: string;
  strike: string;
  sharePrice: string;
  valuationDate: string;
  amount: string;
  term: "90" | "180" | "365" | "3650";
};

const daysAgoIso = (days: number) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const initialForm: FormState = {
  asset: "ANTH.PVT",
  companyIdentifier: "ANTH.PVT",
  grantType: "OPTION",
  units: "20000.0000",
  strike: "2.10",
  // The server replaces these schema placeholders with fresh Yahoo evidence.
  sharePrice: "589.01",
  valuationDate: daysAgoIso(0),
  amount: "1500",
  term: "180"
};

function isFundingResultV2(funding: FundingResult): funding is FundingResultV2 {
  return "version" in funding && funding.version === 2;
}

type WorkflowScreen = "equity" | "advance" | "review" | "receipt";

const navItems: Array<{
  label: string;
  href: string;
  screen: WorkflowScreen;
  icon: LucideIcon;
}> = [
  { label: "Equity profile", href: "#equity", screen: "equity", icon: WalletCards },
  { label: "Financing", href: "#advance", screen: "advance", icon: CircleDollarSign },
  { label: "Documents", href: "#receipt", screen: "receipt", icon: ReceiptText }
];

function Navigation({
  activeScreen,
  onNavigate
}: {
  activeScreen: WorkflowScreen;
  onNavigate: (screen: WorkflowScreen) => void;
}) {
  return (
    <>
      <nav className="primary-nav" aria-label="Main navigation">
        {navItems.map(({ label, href, screen, icon: NavIcon }) => (
          <a
            className={activeScreen === screen ? "is-current" : ""}
            href={href}
            key={label}
            onClick={(event) => {
              event.preventDefault();
              window.history.replaceState(null, "", href);
              onNavigate(screen);
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

function JourneySteps({ stage }: { stage: number }) {
  const steps = [
    ["Equity profile", "Company, grant and identity"],
    ["Financing request", "Amount and repayment timing"],
    ["Review terms", "Valuation and eligibility"],
    ["Documents", "Funding and settlement record"]
  ];

  return (
    <nav aria-label="Equity financing journey" className="journey-steps">
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
      grantType: form.grantType,
      vestedUnits: form.units,
      strikePriceMinor: form.grantType === "OPTION" ? Math.round(Number(form.strike) * 100) : 0,
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
      termDays: Number(form.term) as 90 | 180 | 365 | 3650
    }
  };
}

export function App() {
  const [form, setForm] = useState(initialForm);
  const [activeScreen, setActiveScreen] = useState<WorkflowScreen>("equity");
  const [profileStep, setProfileStep] = useState<1 | 2 | 3 | 4>(1);
  const [profileComplete, setProfileComplete] = useState(false);
  const [vestingPreset, setVestingPreset] = useState<
    "48_MONTHS_CLIFF" | "48_MONTHS_NO_CLIFF" | "CUSTOM"
  >("48_MONTHS_CLIFF");
  const [vestingStart, setVestingStart] = useState("2023-01-15");
  const [vestingFrequency, setVestingFrequency] = useState("Quarterly");
  const [advance, setAdvance] = useState<CustomerAdvance | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<"evaluate" | "fund" | "repay" | null>(null);
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
            Math.max(
              0,
              (selectedCompany?.priceUsdMinor ?? Number(form.sharePrice) * 100) -
                (form.grantType === "OPTION" ? Number(form.strike || 0) * 100 : 0)
            )
        )
      ),
    [form.grantType, form.sharePrice, form.strike, form.units, selectedCompany]
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
    setActiveScreen("equity");
    alignProfile();
  }

  function showScreen(screen: WorkflowScreen) {
    if (screen !== "equity" && !profileComplete) {
      setActiveScreen("equity");
      return;
    }
    if ((screen === "review" || screen === "receipt") && !advance) {
      setActiveScreen("advance");
      return;
    }
    if (screen === "receipt" && !funded) {
      setActiveScreen(advance ? "review" : "advance");
      return;
    }
    setActiveScreen(screen);
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  async function evaluate(event: React.FormEvent) {
    event.preventDefault();
    setBusy("evaluate");
    setError(null);
    try {
      const result = await evaluateAdvance(buildInput(form));
      setAdvance(result.advance);
      setToken(result.confirmationToken);
      setActiveScreen("review");
      window.history.replaceState(null, "", "#review");
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
      setActiveScreen("receipt");
      window.history.replaceState(null, "", "#receipt");
    } catch (cause) {
      const failureCode = cause instanceof Error ? cause.message : "FUNDING_FAILED";
      setError(failureCode);
      setAdvance((current) =>
        current
          ? {
              ...current,
              state: "FUNDING_FAILED",
              failureCode
            }
          : current
      );
    } finally {
      setBusy(null);
    }
  }

  async function repay() {
    if (!advance || !token || advance.state !== "FUNDED") return;
    setBusy("repay");
    setError(null);
    try {
      const repaymentId = `ub_rp_${crypto.randomUUID().replaceAll("-", "")}`;
      const result = await repayAdvance(advance.advanceId, repaymentId, token);
      setAdvance(result.advance);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "REPAYMENT_FAILED");
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
    advance !== null &&
    advance.funding !== null &&
    Boolean(fundingConsensusSuccess || fundingSimulated);
  const repaid = advance !== null && advance.state === "REPAID" && advance.repayment !== null;
  const repaymentPending = advance?.state === "REPAYMENT_PENDING";
  const authorized = advance?.state === "AUTHORIZED";
  const verifiedCount = funded ? 5 : authorized ? 4 : advance ? 3 : profileComplete ? 2 : 0;
  const journeyStage =
    activeScreen === "receipt"
      ? 4
      : activeScreen === "review"
        ? 3
        : activeScreen === "advance"
          ? 2
          : 1;
  const selectedCompanyName = selectedCompany?.companyName ?? "private company";
  const grantLabel = form.grantType === "OPTION" ? "stock options" : "shares";
  const termLabel = form.term === "3650" ? "Until a liquidity event" : `${Number(form.term)} days`;

  return (
    <div className="product-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="#equity" aria-label="unlockd.bond equity workspace">
          unlockd.bond
        </a>
        <Navigation activeScreen={activeScreen} onNavigate={showScreen} />
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
            <strong>Equity financing</strong>
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
              <Navigation
                activeScreen={activeScreen}
                onNavigate={(screen) => {
                  showScreen(screen);
                  setMenuOpen(false);
                }}
              />
            </aside>
          </div>
        ) : null}

        <main className="content" id="overview">
          <section className="assistant-hero" aria-labelledby="workspace-title">
            <p className="eyebrow">Private-company equity financing</p>
            <h1 id="workspace-title">Make your equity work for your financial goals</h1>
            <p>
              Explore financing for stock-option exercise costs or liquidity needs without selling
              your private-company equity today.
            </p>
            <nav className="quick-actions" aria-label="Quick actions">
              <button onClick={() => showScreen("equity")} type="button">
                <WalletCards aria-hidden="true" size={18} />
                Add your equity
              </button>
              <button onClick={() => showScreen("advance")} type="button">
                <CircleDollarSign aria-hidden="true" size={18} />
                Explore financing
              </button>
              <button onClick={() => showScreen("receipt")} type="button">
                <ReceiptText aria-hidden="true" size={18} />
                View documents
              </button>
            </nav>
          </section>

          <JourneySteps stage={journeyStage} />

          {activeScreen === "equity" ? (
            <section className="dashboard-section" id="equity">
              <div className="section-heading">
                <div>
                  <p className="section-kicker">Your equity</p>
                  <h2>Tell us about your private-company equity</h2>
                </div>
                {profileComplete ? (
                  <button className="section-link" onClick={editProfile} type="button">
                    Edit profile
                  </button>
                ) : (
                  <span className="section-meta">Synthetic demo profile</span>
                )}
              </div>

              <article className="profile-flow" aria-label="Private-company equity profile flow">
                <nav aria-label="Equity profile progress" className="profile-progress">
                  {[
                    ["Company", "Private company"],
                    ["Equity award", "Options or shares"],
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
                      <h3>Your {selectedCompanyName} equity is ready for review</h3>
                      <p>
                        {Number(form.units).toLocaleString()} vested {grantLabel} ·{" "}
                        {vestingPreset === "48_MONTHS_CLIFF"
                          ? "48 months with 1-year cliff"
                          : vestingPreset === "48_MONTHS_NO_CLIFF"
                            ? "48 months with no cliff"
                            : "Custom vesting schedule"}{" "}
                        · {vestingFrequency.toLowerCase()}
                      </p>
                    </div>
                    <button
                      className="profile-continue"
                      onClick={() => showScreen("advance")}
                      type="button"
                    >
                      Explore financing
                    </button>
                  </div>
                ) : (
                  <div className="profile-stage">
                    {profileStep === 1 ? (
                      <>
                        <div className="profile-stage-copy">
                          <p className="section-kicker">Step 1 of 4</p>
                          <h3>Which company issued your equity?</h3>
                          <p>
                            Choose your company to see the latest available private-market reference
                            price used for this estimate.
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
                              ? "Loading available companies…"
                              : `${privateCompanies.length} private companies available.`}
                          </span>
                        </label>
                        <div className="company-result">
                          <span className="company-result-mark">
                            <Building2 aria-hidden="true" size={24} />
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
                            <span className="field-label">Current reference share price</span>
                            <span className="control">
                              <span className="control-prefix">Yahoo</span>
                              <input
                                aria-label="Current reference share price"
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
                                ? `Updated ${new Date(selectedCompany.priceUpdatedAt * 1000).toLocaleDateString()}`
                                : "A current or recently cached reference price is required."}
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
                              Context only. Eligibility is based on the reference share price.
                            </span>
                          </div>
                        </div>
                      </>
                    ) : null}

                    {profileStep === 2 ? (
                      <>
                        <div className="profile-stage-copy">
                          <p className="section-kicker">Step 2 of 4</p>
                          <h3>What type of equity do you hold?</h3>
                          <p>
                            Add vested stock options or shares. Unvested awards are not included in
                            the financing estimate.
                          </p>
                        </div>
                        <fieldset className="vesting-options grant-type-options">
                          <legend>Equity award type</legend>
                          <button
                            aria-pressed={form.grantType === "OPTION"}
                            className={form.grantType === "OPTION" ? "is-selected" : ""}
                            onClick={() => {
                              setForm({ ...form, grantType: "OPTION" });
                              resetEvaluation();
                            }}
                            type="button"
                          >
                            <strong>Stock options</strong>
                            <span>Exercise price applies</span>
                          </button>
                          <button
                            aria-pressed={form.grantType === "RSU"}
                            className={form.grantType === "RSU" ? "is-selected" : ""}
                            onClick={() => {
                              setForm({ ...form, grantType: "RSU", strike: "0" });
                              resetEvaluation();
                            }}
                            type="button"
                          >
                            <strong>Shares or RSUs</strong>
                            <span>No exercise price</span>
                          </button>
                        </fieldset>
                        <div className="profile-fields">
                          <Field
                            help="Enter only awards that have vested."
                            label={`Vested ${form.grantType === "OPTION" ? "options" : "shares"}`}
                            onChange={(value) => {
                              setForm({ ...form, units: value });
                              resetEvaluation();
                            }}
                            prefix={form.asset.replace(".PVT", "")}
                            value={form.units}
                          />
                          {form.grantType === "OPTION" ? (
                            <Field
                              help="The amount you pay the company to exercise one option."
                              label="Exercise price per option"
                              onChange={(value) => {
                                setForm({ ...form, strike: value });
                                resetEvaluation();
                              }}
                              prefix="USD"
                              value={form.strike}
                            />
                          ) : null}
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
                              <small>Option grant, share statement and vesting evidence</small>
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
                          ? "Continue to equity award"
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
                  <span className="metric-unit">vested {grantLabel}</span>
                  <div className="metric-status">
                    <TrendingUp aria-hidden="true" size={16} />
                    Included in your estimate
                  </div>
                </article>

                <article className="metric-card share-price-card">
                  <span className="card-label">Current reference share price</span>
                  <strong>
                    {selectedCompany ? usdPrecise(selectedCompany.priceUsdMinor) : "Unavailable"}
                  </strong>
                  <span className="metric-unit">per share</span>
                  <div className="metric-status">
                    <Building2 aria-hidden="true" size={16} />
                    {selectedCompanyName} · private-market estimate
                  </div>
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
                  <button onClick={() => showScreen("advance")} type="button">
                    Explore financing
                  </button>
                </article>
              </div>
            </section>
          ) : null}

          <div className="flow-grid is-single">
            {activeScreen === "advance" ? (
              <form className="application panel" id="advance" onSubmit={evaluate}>
                <div className="panel-heading">
                  <div>
                    <p className="section-kicker">Financing request</p>
                    <h2>Choose how much financing you need</h2>
                  </div>
                  <span className="private-badge">
                    <LockKeyhole aria-hidden="true" size={14} />
                    Private
                  </span>
                </div>

                <p className="panel-copy">
                  See an indicative financing amount based on your eligible equity. This estimate is
                  not a commitment to lend, and no transaction occurs until you accept the demo
                  terms.
                </p>

                <div className="form-grid">
                  <div className="loan-slider">
                    <div className="loan-slider-heading">
                      <div>
                        <span className="field-label">Requested financing amount</span>
                        <strong>{usd(Math.round(Number(form.amount || 0) * 100))}</strong>
                      </div>
                      <span>
                        Maximum available
                        <strong>{usd(maxBorrowMinor)}</strong>
                      </span>
                    </div>
                    <input
                      aria-label="Requested financing amount"
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
                      <span>Up to 70% of estimated net equity value</span>
                    </div>
                  </div>
                  <label className="field">
                    <span className="field-label">Repayment timing</span>
                    <span className="control">
                      <span className="control-prefix">Term</span>
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
                        <option value="90">90 days</option>
                        <option value="180">180 days</option>
                        <option value="365">365 days</option>
                        <option value="3650">Until a liquidity event</option>
                      </select>
                    </span>
                    <span className="field-help">
                      Choose a fixed term or align repayment with an eligible liquidity event.
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
                        ? `${selectedCompanyName} equity and verification inputs are ready for review.`
                        : "Company, equity award, vesting, identity, and document checks are required first."}
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
                    ? "Preparing your estimate…"
                    : profileComplete
                      ? "Review financing estimate"
                      : "Complete equity profile first"}
                </button>
                <p className="privacy-footnote">
                  Raw employee inputs are processed transiently and never written to public
                  receipts.
                </p>
              </form>
            ) : null}

            {activeScreen === "review" ? (
              <aside className="evidence panel" id="review" aria-label="Financing review">
                <div className="panel-heading">
                  <div>
                    <p className="section-kicker">Your estimate</p>
                    <h2>Review your financing terms</h2>
                  </div>
                  <span className={`summary-status ${advance ? "is-ready" : ""}`}>
                    {advance ? "Ready to review" : "Awaiting input"}
                  </span>
                </div>

                {error ? (
                  <div className="funding-error" role="alert">
                    <strong>Financing was not issued</strong>
                    <p>
                      {error === "HEDERA_INSUFFICIENT_PAYER_BALANCE" ||
                      error === "OPERATOR_HBAR_RESERVE_REQUIRED"
                        ? "The Hedera Testnet fee account needs more HBAR. No explorer receipt was created."
                        : error.replaceAll("_", " ")}
                    </p>
                    <button
                      onClick={() => {
                        resetEvaluation();
                        setActiveScreen("advance");
                        window.history.replaceState(null, "", "#advance");
                      }}
                      type="button"
                    >
                      Create a fresh financing request
                    </button>
                  </div>
                ) : null}

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
                        <span className="section-kicker">Equity estimate</span>
                        <h3 id="valuation-title">How we calculated your eligibility</h3>
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
                          <dt>Vested share value</dt>
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
                        <dt>Maximum estimated financing · 70%</dt>
                        <dd>{usd(advance.pricing.equityBasedCreditLimitMinor)}</dd>
                      </div>
                      <div>
                        <dt>Requested financing</dt>
                        <dd>{usd(Math.round(Number(form.amount) * 100))}</dd>
                      </div>
                    </dl>
                    <p>
                      The estimate uses vested equity, the available reference share price, and the
                      exercise price for options. Compensation data is not collected or used.
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
                            ? "Estimated financing amount"
                            : "Financing authorized"}
                        </span>
                        <strong>{usd(advance.authorization.amountMinor)}</strong>
                      </div>
                    </div>
                    <dl>
                      <div>
                        <dt>Repayment timing</dt>
                        <dd>{advance.termDays === 3650 ? "Until a liquidity event" : termLabel}</dd>
                      </div>
                      <div>
                        <dt>Policy cap</dt>
                        <dd>{usd(advance.authorization.policyMaxMinor)}</dd>
                      </div>
                    </dl>
                    <button disabled={busy !== null} onClick={fund} type="button">
                      <Landmark aria-hidden="true" size={17} />
                      {busy === "fund" ? "Accepting…" : "Accept demo financing"}
                    </button>
                    <p>Demo USDC has no real value and creates no legal repayment obligation.</p>
                  </section>
                ) : null}

                {funded && advance?.state !== "REPAID" ? (
                  <section className="approval repayment-panel">
                    <div className="approval-heading">
                      <span className="approval-icon">
                        <CircleDollarSign aria-hidden="true" size={18} />
                      </span>
                      <div>
                        <span>Outstanding principal</span>
                        <strong>{usd(advance.authorization.amountMinor)}</strong>
                      </div>
                    </div>
                    <dl>
                      <div>
                        <dt>Repayment asset</dt>
                        <dd>Demo USDC</dd>
                      </div>
                      <div>
                        <dt>Interest and fees</dt>
                        <dd>$0.00</dd>
                      </div>
                    </dl>
                    <button
                      disabled={
                        busy !== null ||
                        !token ||
                        repaymentPending ||
                        advance.state === "REPAYMENT_REVIEW_REQUIRED"
                      }
                      onClick={repay}
                      type="button"
                    >
                      <CircleDollarSign aria-hidden="true" size={17} />
                      {busy === "repay"
                        ? "Repaying on Hedera…"
                        : repaymentPending
                          ? "Repayment pending…"
                          : advance.state === "REPAYMENT_REVIEW_REQUIRED"
                            ? "Manual review required"
                            : "Repay full principal"}
                    </button>
                    <p>
                      Returns Demo USDC to the treasury and permanently retires the Advance Note.
                    </p>
                  </section>
                ) : null}

                {repaid && advance?.repayment ? (
                  <section className="approval repayment-panel is-repaid">
                    <div className="approval-heading">
                      <span className="approval-icon">
                        <Check aria-hidden="true" size={18} />
                      </span>
                      <div>
                        <span>Advance repaid</span>
                        <strong>{usd(advance.repayment.asset.amountMinor)}</strong>
                      </div>
                    </div>
                    <p>The full principal was returned and the Advance Note was retired.</p>
                  </section>
                ) : null}
              </aside>
            ) : null}
          </div>

          {activeScreen === "receipt" ? (
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
                  {advance.repayment ? (
                    <div className="repayment-receipt">
                      <div className="panel-heading receipt-title">
                        <div>
                          <p className="section-kicker">Repayment audit record</p>
                          <h3>Repaid receipt</h3>
                        </div>
                        <span className="summary-status is-ready">
                          {advance.repayment.simulated ? "Simulated receipt" : "Consensus SUCCESS"}
                        </span>
                      </div>
                      <dl className="receipt-data">
                        <div>
                          <dt>Principal returned</dt>
                          <dd>
                            {(advance.repayment.asset.amountMinor / 100).toFixed(2)} USDC
                            <span className="demo-token-label">Demo Testnet Token</span>
                          </dd>
                        </div>
                        {(
                          [
                            [
                              "Repayment authorization HCS",
                              advance.repayment.transactions.authorization
                            ],
                            [
                              "Atomic repayment settlement",
                              advance.repayment.transactions.settlement
                            ],
                            ["Advance Note burn", advance.repayment.transactions.noteBurn],
                            ["Repaid HCS", advance.repayment.transactions.repaidEvent]
                          ] as const
                        ).map(([label, transaction]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>
                              {advance.repayment?.simulated ? (
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
                          <dt>Advance Note</dt>
                          <dd>
                            <a
                              href={advance.repayment.note.hashscanUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {advance.repayment.note.tokenId}/{advance.repayment.note.serial} ·
                              retired
                              <ExternalLink aria-hidden="true" size={13} />
                            </a>
                          </dd>
                        </div>
                        <div>
                          <dt>Repayment ID</dt>
                          <dd>{advance.repayment.repaymentId}</dd>
                        </div>
                      </dl>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="empty-receipt">
                  <ReceiptText aria-hidden="true" size={26} />
                  <div>
                    <strong>No receipt yet</strong>
                    <p>Accept the demo financing to create a verifiable settlement record.</p>
                  </div>
                </div>
              )}
            </section>
          ) : null}

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
