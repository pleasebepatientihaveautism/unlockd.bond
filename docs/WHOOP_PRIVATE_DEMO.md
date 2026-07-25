# WHOOP private-company demo

This is a synthetic hackathon example showing how unlockd.bond can estimate a bounded credit line
for vested equity in a company that is still private.

## Evidence model

- Verify that the employee grant exists, is vested, and remains transfer-restricted.
- Use a recent common-share fair market value, such as a 409A valuation, rather than treating a
  preferred funding-round valuation as an employee share price.
- For options, subtract the exercise price before applying policy controls.
- Reject evidence older than one year and keep the evidence source, date, and valuation basis in
  the decision record.

WHOOP announced a $575 million Series G at a $10.1 billion company valuation on March 31, 2026.
That is included only as company-level context. It is not used as the employee common-share price.

## Synthetic calculation

| Input | Demo value |
| --- | ---: |
| Vested options | 20,000 |
| Synthetic common-share FMV | $4.80 |
| Exercise price | $1.20 |
| Net vested option value | $72,000 |
| Private-company illiquidity haircut | 60% |
| Additional policy buffer | 10% |
| Eligible equity value | $21,600 |
| Equity-based policy limit (25%) | $5,400 |
| Default requested test line | $1,500 |

The executed amount is the lowest of the requested amount, half of monthly net income, the private
risk recommendation, 25% of eligible equity value, and the fixed program cap.

## Boundaries

- All profile, grant, valuation, and funding data in this path are synthetic.
- It does not originate credit, perform KYC, transfer shares, perfect a lien, or create legal
  collateral.
- WHOOP shares remain restricted and non-tradable in the demo.
- Hedera Testnet records are simulated receipts unless the application is separately provisioned
  with valid funded Testnet accounts, keys, token IDs, and topic IDs.
