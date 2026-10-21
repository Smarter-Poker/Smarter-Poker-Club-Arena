import { useEffect, useState } from 'react';
import { readCashRakePolicyVersion } from '../services/cashRakePolicyVersion';
/** One read when the operator opens the page; no timer or release polling. */
export function useCashRakePolicyVersion(): 0 | 1 | null {
  const [version, setVersion] = useState<0 | 1 | null>(null);
  useEffect(() => {
    let active = true;
    void readCashRakePolicyVersion().then((value) => {
      if (active) setVersion(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return version;
}
