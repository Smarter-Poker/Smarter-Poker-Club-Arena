import {it,expect,vi} from 'vitest';
it('actual explicit entry imports without network or output/configuration construction',async()=>{
 const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('unexpected transport'));
 const output=vi.spyOn(process.stdout,'write');
 try{const entry=await import('../../../scripts/horseDailyCorrectiveReview.ts');expect(typeof entry.runHorseDailyCorrectiveReview).toBe('function');expect(network).not.toHaveBeenCalled();expect(output).not.toHaveBeenCalled();}finally{network.mockRestore();output.mockRestore();}
});
