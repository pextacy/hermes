// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title Hermes HTLC — EVM side of a USDC ⇄ PUSD atomic swap.
/// @notice Funds are locked against SHA-256(secret) — the same hash function the BCH side
///         uses (OP_SHA256) — so revealing the 32-byte secret on one chain unlocks the other.
///         No admin, no upgradeability, no custody beyond the lock itself.
contract HermesHTLC {
    enum State {
        None,
        Locked,
        Claimed,
        Refunded
    }

    struct Lock {
        address sender;
        address recipient;
        address token;
        uint256 amount;
        bytes32 hashlock;
        uint64 timeout;
        State state;
    }

    mapping(bytes32 => Lock) public locks;
    mapping(address => uint256) public nonces;
    uint256 private entered = 1;

    event Locked(
        bytes32 indexed id,
        address indexed sender,
        address indexed recipient,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint64 timeout
    );
    event Claimed(bytes32 indexed id, bytes32 preimage);
    event Refunded(bytes32 indexed id);

    error InvalidAmount();
    error InvalidRecipient();
    error InvalidTimeout();
    error UnknownLock();
    error NotLocked();
    error WrongPreimage();
    error BadPreimageLength();
    error Expired();
    error NotExpired();
    error TransferFailed();
    error Reentrancy();
    error FeeOnTransferNotSupported();

    modifier nonReentrant() {
        if (entered != 1) revert Reentrancy();
        entered = 2;
        _;
        entered = 1;
    }

    /// @notice Deterministic lock id (the sender's nonce makes repeated identical locks distinct).
    function computeId(
        address sender,
        address recipient,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint64 timeout,
        uint256 nonce
    ) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), sender, recipient, token, amount, hashlock, timeout, nonce));
    }

    function lock(address token, uint256 amount, address recipient, bytes32 hashlock, uint64 timeout)
        external
        nonReentrant
        returns (bytes32 id)
    {
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0) || recipient == msg.sender) revert InvalidRecipient();
        if (timeout <= block.timestamp) revert InvalidTimeout();
        id = computeId(msg.sender, recipient, token, amount, hashlock, timeout, nonces[msg.sender]++);
        locks[id] = Lock(msg.sender, recipient, token, amount, hashlock, timeout, State.Locked);

        uint256 before = IERC20(token).balanceOf(address(this));
        _safeTransferFrom(token, msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert FeeOnTransferNotSupported();

        emit Locked(id, msg.sender, recipient, token, amount, hashlock, timeout);
    }

    /// @notice Anyone may submit the preimage; funds always go to the recipient.
    function claim(bytes32 id, bytes calldata preimage) external nonReentrant {
        Lock storage l = locks[id];
        if (l.state == State.None) revert UnknownLock();
        if (l.state != State.Locked) revert NotLocked();
        if (preimage.length != 32) revert BadPreimageLength();
        if (sha256(preimage) != l.hashlock) revert WrongPreimage();
        if (block.timestamp >= l.timeout) revert Expired();
        l.state = State.Claimed;
        _safeTransfer(l.token, l.recipient, l.amount);
        emit Claimed(id, bytes32(preimage));
    }

    /// @notice After the timeout anyone may trigger the refund; funds always go back to the sender.
    function refund(bytes32 id) external nonReentrant {
        Lock storage l = locks[id];
        if (l.state == State.None) revert UnknownLock();
        if (l.state != State.Locked) revert NotLocked();
        if (block.timestamp < l.timeout) revert NotExpired();
        l.state = State.Refunded;
        _safeTransfer(l.token, l.sender, l.amount);
        emit Refunded(id);
    }

    function _safeTransfer(address token, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, value)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transferFrom, (from, to, value)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
