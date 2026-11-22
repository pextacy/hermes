// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HermesHTLC} from "../src/HermesHTLC.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// Token that re-enters the HTLC during transfer, to prove the guard holds.
contract ReentrantToken is MockUSDC {
    HermesHTLC public target;
    bytes32 public lockId;
    bool public armed;
    bool public reentered;

    function arm(HermesHTLC t, bytes32 id) external {
        target = t;
        lockId = id;
        armed = true;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (armed) {
            armed = false;
            try target.refund(lockId) {
                reentered = true;
            } catch {}
        }
        return super.transfer(to, value);
    }
}

contract FeeToken is MockUSDC {
    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        super.transferFrom(from, to, value);
        // burn 1% from the recipient to simulate a fee-on-transfer token
        balanceOf[to] -= value / 100;
        return true;
    }
}

contract HermesHTLCTest is Test {
    HermesHTLC htlc;
    MockUSDC usdc;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    bytes32 secret = keccak256("hermes secret");
    bytes32 hashlock;

    function setUp() public {
        htlc = new HermesHTLC();
        usdc = new MockUSDC();
        hashlock = sha256(abi.encodePacked(secret));
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(htlc), type(uint256).max);
        vm.warp(1_800_000_000);
    }

    function _lock(uint64 timeout) internal returns (bytes32 id) {
        vm.prank(alice);
        id = htlc.lock(address(usdc), 100e6, bob, hashlock, timeout);
    }

    function testLockMovesFundsAndEmits() public {
        vm.expectEmit(false, true, true, true);
        emit HermesHTLC.Locked(bytes32(0), alice, bob, address(usdc), 100e6, hashlock, uint64(block.timestamp + 3 hours));
        bytes32 id = _lock(uint64(block.timestamp + 3 hours));
        assertEq(usdc.balanceOf(address(htlc)), 100e6);
        (address sender, address recipient,, uint256 amount, bytes32 h, uint64 t, HermesHTLC.State s) = htlc.locks(id);
        assertEq(sender, alice);
        assertEq(recipient, bob);
        assertEq(amount, 100e6);
        assertEq(h, hashlock);
        assertEq(t, block.timestamp + 3 hours);
        assertEq(uint8(s), uint8(HermesHTLC.State.Locked));
    }

    function testClaimWithSecretPaysRecipient() public {
        bytes32 id = _lock(uint64(block.timestamp + 3 hours));
        vm.expectEmit(true, false, false, true);
        emit HermesHTLC.Claimed(id, secret);
        vm.prank(address(0xCAFE)); // anyone may submit; funds still go to bob
        htlc.claim(id, abi.encodePacked(secret));
        assertEq(usdc.balanceOf(bob), 100e6);
        assertEq(usdc.balanceOf(address(htlc)), 0);
    }

    function testWrongPreimageReverts() public {
        bytes32 id = _lock(uint64(block.timestamp + 3 hours));
        vm.expectRevert(HermesHTLC.WrongPreimage.selector);
        htlc.claim(id, abi.encodePacked(keccak256("nope")));
    }

    function testPreimageLengthChecked() public {
        bytes32 id = _lock(uint64(block.timestamp + 3 hours));
        vm.expectRevert(HermesHTLC.BadPreimageLength.selector);
        htlc.claim(id, abi.encodePacked(secret, bytes1(0x00)));
        vm.expectRevert(HermesHTLC.BadPreimageLength.selector);
        htlc.claim(id, hex"00");
    }

    function testClaimAfterTimeoutReverts() public {
        bytes32 id = _lock(uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(HermesHTLC.Expired.selector);
        htlc.claim(id, abi.encodePacked(secret));
    }

    function testRefundOnlyAfterTimeout() public {
        bytes32 id = _lock(uint64(block.timestamp + 1 hours));
        vm.expectRevert(HermesHTLC.NotExpired.selector);
        htlc.refund(id);
        vm.warp(block.timestamp + 1 hours);
        htlc.refund(id);
        assertEq(usdc.balanceOf(alice), 1_000e6);
    }

    function testNoDoubleSpend() public {
        bytes32 id = _lock(uint64(block.timestamp + 1 hours));
        htlc.claim(id, abi.encodePacked(secret));
        vm.expectRevert(HermesHTLC.NotLocked.selector);
        htlc.claim(id, abi.encodePacked(secret));
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(HermesHTLC.NotLocked.selector);
        htlc.refund(id);
    }

    function testUnknownLock() public {
        vm.expectRevert(HermesHTLC.UnknownLock.selector);
        htlc.refund(bytes32(uint256(1)));
    }

    function testInputValidation() public {
        vm.startPrank(alice);
        vm.expectRevert(HermesHTLC.InvalidAmount.selector);
        htlc.lock(address(usdc), 0, bob, hashlock, uint64(block.timestamp + 1));
        vm.expectRevert(HermesHTLC.InvalidRecipient.selector);
        htlc.lock(address(usdc), 1, address(0), hashlock, uint64(block.timestamp + 1));
        vm.expectRevert(HermesHTLC.InvalidRecipient.selector);
        htlc.lock(address(usdc), 1, alice, hashlock, uint64(block.timestamp + 1));
        vm.expectRevert(HermesHTLC.InvalidTimeout.selector);
        htlc.lock(address(usdc), 1, bob, hashlock, uint64(block.timestamp));
        vm.stopPrank();
    }

    function testIdenticalLocksGetDistinctIds() public {
        bytes32 a = _lock(uint64(block.timestamp + 1 hours));
        bytes32 b = _lock(uint64(block.timestamp + 1 hours));
        assertTrue(a != b);
    }

    function testReentrancyBlocked() public {
        ReentrantToken t = new ReentrantToken();
        t.mint(alice, 100e6);
        vm.prank(alice);
        t.approve(address(htlc), type(uint256).max);
        vm.prank(alice);
        bytes32 id = htlc.lock(address(t), 100e6, bob, hashlock, uint64(block.timestamp + 1 hours));
        t.arm(htlc, id);
        vm.warp(block.timestamp + 2 hours); // refund would be valid if re-entered
        // claim is expired; arm a re-entrant refund during the refund's own transfer
        htlc.refund(id);
        assertFalse(t.reentered());
        assertEq(t.balanceOf(alice), 100e6);
    }

    function testFeeOnTransferRejected() public {
        FeeToken f = new FeeToken();
        f.mint(alice, 100e6);
        vm.prank(alice);
        f.approve(address(htlc), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(HermesHTLC.FeeOnTransferNotSupported.selector);
        htlc.lock(address(f), 100e6, bob, hashlock, uint64(block.timestamp + 1 hours));
    }

    function testSha256MatchesBchSide() public pure {
        // Same vector as tests/swap.test.ts: SHA-256 of 32 bytes 0x01..0x20.
        bytes memory s = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
        assertEq(sha256(s), hex"ae216c2ef5247a3782c135efa279a3e4cdc61094270f5d2be58c6204b7a612c9");
    }

    function testFuzzClaimOnlyWithExactSecret(bytes32 guess) public {
        vm.assume(guess != secret);
        bytes32 id = _lock(uint64(block.timestamp + 1 hours));
        vm.expectRevert(HermesHTLC.WrongPreimage.selector);
        htlc.claim(id, abi.encodePacked(guess));
    }
}
