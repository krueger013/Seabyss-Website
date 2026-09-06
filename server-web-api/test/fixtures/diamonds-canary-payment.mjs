// Offline fixture identity only. All provider and financial writes in these tests are fakes.
process.env.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID = "C5BD37AA141B3C4E";
delete process.env.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS;
process.env.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID = "1D0C16";
