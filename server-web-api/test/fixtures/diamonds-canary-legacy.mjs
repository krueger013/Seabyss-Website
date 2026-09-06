// Offline fixture identity only. All provider and financial writes in these tests are fakes.
process.env.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID = "61AD15CDA4137EA9";
delete process.env.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS;
process.env.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID = "1D0C16";
