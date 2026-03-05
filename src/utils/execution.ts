import { encodeAbiParameters, encodePacked, type Hex } from 'viem';

/** ModeCode for CALLTYPE_SINGLE (0x00) + EXECTYPE_DEFAULT (0x00) + padding.
 *  Layout: [1 byte callType][1 byte execType][4 bytes unused][4 bytes context][22 bytes payload]
 *  Matches ModeLib.encodeSimpleSingle() in Solidity. */
export function encodeSimpleSingle(): Hex {
  return '0x0000000000000000000000000000000000000000000000000000000000000000';
}

/** ModeCode for CALLTYPE_BATCH (0x01) + EXECTYPE_DEFAULT (0x00) + padding.
 *  Matches ModeLib.encodeSimpleBatch() in Solidity. */
export function encodeSimpleBatch(): Hex {
  return '0x0100000000000000000000000000000000000000000000000000000000000000';
}

/** Encode a single execution target: abi.encodePacked(target, value, callData).
 *  Matches ExecutionLib.encodeSingle() in Solidity. */
export function encodeSingleExecution(
  target: `0x${string}`,
  value: bigint,
  callData: Hex,
): Hex {
  return encodePacked(
    ['address', 'uint256', 'bytes'],
    [target, value, callData],
  );
}

/** Encode batch execution: abi.encode(Execution[]).
 *  Matches ExecutionLib.decodeBatch() expectation in Solidity.
 *  Execution is (address target, uint256 value, bytes callData). */
export function encodeBatchExecution(
  calls: Array<{ target: `0x${string}`; value: bigint; data: Hex }>,
): Hex {
  return encodeAbiParameters(
    [{ type: 'tuple[]', components: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ]}],
    [calls.map(c => ({ target: c.target, value: c.value, callData: c.data }))],
  );
}
