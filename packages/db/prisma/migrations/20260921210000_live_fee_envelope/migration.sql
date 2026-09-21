ALTER TABLE portfolios ADD COLUMN native_fee_reserve_sol DECIMAL(30,10) NOT NULL DEFAULT 0;
ALTER TABLE portfolios ADD CONSTRAINT portfolios_native_fee_nonnegative CHECK (native_fee_reserve_sol >= 0);
