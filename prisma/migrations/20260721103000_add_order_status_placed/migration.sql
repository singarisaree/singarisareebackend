-- Step 1: add PLACED (must be committed before use — see next migration).
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PLACED';
