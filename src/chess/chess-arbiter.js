import * as PositioningUtils from "./positioning-utils";
import * as GameNetwork from "./game-network";
import * as Chess from "chess.js";
import { GAME_MODE, COLOR } from './game-constants';

AFRAME.registerSystem("chess-arbiter", {
  init() {
    this.playAsEvent = this.playAsEvent.bind(this);
    this.copyPGN = this.copyPGN.bind(this);
    this.copyFEN = this.copyFEN.bind(this);
    this.resetNetworkedGame = this.resetNetworkedGame.bind(this);
    this.tick = AFRAME.utils.throttleTick(this.tick, 300, this);
    this.state = this.sceneEl.systems.state.state;
    this.chessGame = this.sceneEl.querySelector("a-entity[chess-game]");
    this.announceCurrentPlayer = this.announceCurrentPlayer.bind(this);
    this.sceneEl.addEventListener("chess-command", ev => {
      const params = ev.detail;
      const command = params.shift();
      this.handleChatCommand(command, params);
    });
    this.startGame();
    this.setGameMode();
    GameNetwork.setupNetwork(this.sceneEl);
    this.addEventListeners();
  },

  remove() {
    this.removeEventListeners();
  },

  tick() {
    if (this.state.imPlaying) {
      const pieces = this.sceneEl.querySelectorAll("a-entity[chess-set] a-entity[chess-piece] a-entity.chess-piece");
      for (const piece of pieces) {
        if (piece && piece.metadata) {
          this.interactionHandler(piece);
        }
      }
    }
  },

  addEventListeners() {
    this.el.sceneEl.addEventListener("chess:playAs", this.playAsEvent);
    this.el.sceneEl.addEventListener("chess:copyPGN", this.copyPGN);
    this.el.sceneEl.addEventListener("chess:copyFEN", this.copyFEN);
    this.el.sceneEl.addEventListener("chess:resetNetworkedGame", this.resetNetworkedGame);
  },

  removeEventListeners() {
    this.el.sceneEl.removeEventListener("chess:playAs", this.playAsEvent);
    this.el.sceneEl.removeEventListener("chess:copyPGN", this.copyPGN);
    this.el.sceneEl.removeEventListener("chess:copyFEN", this.copyFEN);
    this.el.sceneEl.removeEventListener("chess:resetNetworkedGame", this.resetNetworkedGame);
  },

  playAsEvent(ev) {
    const color = ev.detail.color;
    const id = GameNetwork.getMyId();
    const profile = window.APP.store.state.profile;
    this.playAs(color, id, profile);
  },

  startGame(fen = "") {
    this.chessEngine = fen ? new Chess(fen) : new Chess();
  },

  resetGame(fen = "") {
    // if an event object is sent in from an eventListener, clear it out
    if (typeof fen !== "string") {
      fen = "";
    }
    document.body.removeEventListener("clientConnected", this.announceCurrentPlayer);
    this.destroyMyPieces();
    this.sceneEl.emit("resetChessState");
    this.startGame(fen);
    // reset scale & position after game
    this.sceneEl.systems["hubs-systems"].waypointSystem.moveToSpawnPoint();
  },

  resetNetworkedGame(fen = "") {
    GameNetwork.broadcastData("chess::reset-game", { fen });
    this.resetGame(fen);
    this.setGameMode(fen);
  },

  setGameMode(fen = "") {
    const gameMode = (fen) ? GAME_MODE.FEN : GAME_MODE.STANDARD; 
    GameNetwork.broadcastData("chess::set-game-mode", { gameMode });
    this.sceneEl.emit("setGameMode", { gameMode });
  },

  loadPGN(pgn) {
    pgn = pgn.replaceAll('] [', ']\n[');
    pgn = pgn.replace('] 1.', ']\n\n1.');
    this.chessEngine.load_pgn(pgn);
  },

  loadNetworkedPGN(pgn) {
    const gameMode = GAME_MODE.PGN;
    GameNetwork.broadcastData("chess::set-game-mode", { gameMode });
    this.sceneEl.emit("setGameMode", { gameMode });
    this.loadPGN(pgn)
    GameNetwork.broadcastData("chess::load-pgn", { pgn });
  },

  copyPGN() {
    const notation = this.chessEngine.pgn();
    navigator.clipboard.writeText(notation);
  },

  copyFEN() {
    const notation = this.chessEngine.fen();
    navigator.clipboard.writeText(notation);
  },

  handleChatCommand(command, params) {
    const id = GameNetwork.getMyId();
    const profile = window.APP.store.state.profile;
    const color = params[0];
    const notation = params.join(" ");
    switch (command) {
      case "play":
        this.playAs(color, id, profile);
        break;
      case "reset":
        this.resetNetworkedGame();
        break;
      case COLOR.W:
        this.playAs(COLOR.WHITE, id, profile);
        break;
      case COLOR.B:
        this.playAs(COLOR.BLACK, id, profile);
        break;
      case "fen":
        this.resetNetworkedGame(notation);
        break;
      case "pgn":
        this.loadNetworkedPGN(notation);
        break;
    }
  },

  async playAs(color, id, profile) {
    if (!this.chessGame) {
      this.chessGame = await this.boardPosition.addChessGame();
    }
    const colorAvailable = !this.state.players[color].id;
    if (colorAvailable) {
      this.sceneEl.emit("imPlaying", { color, id, profile });
      GameNetwork.broadcastData("chess::set-player", { color, id, profile });
      const chessSet = document.createElement("a-entity");
      chessSet.setAttribute("chess-set", `color: ${color}`);
      chessSet.setAttribute("networked", "template: #static-game-avatar");
      this.chessGame.appendChild(chessSet);
      this.teleportPlayer(color);
      // When new players connect, send them information on current players directly.
      document.body.addEventListener("clientConnected", this.announceCurrentPlayer);
    }
  },

  announceCurrentPlayer(ev) {
    const color = this.state.myColor;
    const playerData = {
      id: GameNetwork.getMyId(),
      profile: window.APP.store.state.profile,
      color: color,
      pieces: this.state.players[color].pieces
    };
    GameNetwork.sendData(ev.detail.clientId, "chess::set-player", playerData);
  },

  interactionHandler(piece) {
    const interaction = window.AFRAME.scenes[0].systems.interaction;
    const isHeld = interaction && interaction.isHeld(piece);
    const wasHeld = piece.metadata.wasHeld;
    if (isHeld) {
      if (!this.state.imPlaying) {
        this.onPieceGoBack(piece);
      }
      this.onPieceHeld(piece);
    } else if (wasHeld) {
      if (PositioningUtils.isOnBoard(piece) === false) {
        this.onPieceGoBack(piece);
      } else {
        this.onPieceDropped(piece);
      }
      piece.metadata.wasHeld = false;
    }
  },

  onPieceHeld(piece) {
    const moves = piece.metadata.moves;
    const lastSquare = piece.metadata.lastSquare;
    if (moves.length === 0) {
      this.populateMoves(piece);
    }
    const position = piece.getAttribute("position");
    const square = PositioningUtils.getSquareFromPosition(position).square;
    const isSquareValid = moves.indexOf(square) !== -1 || square === lastSquare;
    this.sceneEl.emit("chess-cursor", { enabled: true, valid: true, position });
    if (PositioningUtils.isOnBoard(piece) === false || isSquareValid === false) {
      this.sceneEl.emit("chess-cursor", { enabled: true, valid: false, position });
    }
    this.sceneEl.emit("chess-piece-held", { piece });
    piece.metadata.wasHeld = true;
  },

  onPieceGoBack(piece) {
    const lastSquare = piece.metadata.lastSquare;
    this.moveTo(piece, lastSquare);
    this.sceneEl.emit("chess-cursor", { enabled: false, valid: false });
  },

  onPieceDropped(piece) {
    const lastSquare = piece.metadata.lastSquare;
    const lastPosition = piece.metadata.lastPosition;
    const pieceType = piece.metadata.type;
    const destinationSquare = PositioningUtils.getSquareFromPosition(piece.getAttribute("position"));
    const destinationX = PositioningUtils.getPositionFromFile(destinationSquare.file);
    const destinationZ = PositioningUtils.getPositionFromRank(destinationSquare.rank);
    const currentY = piece.getAttribute("position").y;
    if (destinationX !== null && destinationZ !== null) {
      const isPositionChanged =
        destinationX !== lastPosition.x || currentY !== lastPosition.y || destinationZ !== lastPosition.z;
      if (isPositionChanged) {
        const moveDetails = { from: lastSquare, to: destinationSquare.square };
        if (pieceType === "p" && (destinationSquare.rank === "8" || destinationSquare.rank === "1")) {
          moveDetails.promotion = "q";
        }
        const move = this.chessEngine.move(moveDetails);
        if (move) {
          GameNetwork.broadcastData("chess::sync-move", moveDetails);
          this.doMove(move);
          this.sceneEl.emit("chess-piece-moved", { piece });
        }
        if (!move || lastSquare === destinationSquare.square) {
          this.onPieceGoBack(piece);
        } else if (move) {
          this.snapPiece(piece);
        }
      }
    }
  },

  moveTo(piece, square) {
    const pieceY = piece.metadata.pieceY;
    const color = piece.metadata.color;
    const { rank, file } = PositioningUtils.getRankFile(square);
    if (!rank || !file) return;
    const position = {
      x: PositioningUtils.getPositionFromFile(file),
      y: pieceY,
      z: PositioningUtils.getPositionFromRank(rank)
    };
    const preventThrowing = this.chessGame.getAttribute("chess-game").preventThrowing;
    if (preventThrowing) {
      piece.setAttribute("body-helper", "type: static;");
    }
    piece.setAttribute("position", position, true);
    piece.fireResetRotation();
    const lastPosition = position;
    const lastSquare = `${file}${rank}`;
    piece.metadata.lastPosition = lastPosition;
    piece.metadata.lastSquare = lastSquare;
    const updateData = { id: piece.id, lastSquare, color };
    this.sceneEl.emit("updatePiece", updateData);
    GameNetwork.broadcastData("chess::update-piece", updateData);
    this.populateMoves(piece);
    if (preventThrowing) {
      piece.setAttribute("body-helper", "");
    }
    return true;
  },

  doMove(move) {
    const isCapture = move.flags.indexOf("c") !== -1;
    const isQueensideCastle = move.flags.indexOf("q") !== -1;
    const isKingsideCastle = move.flags.indexOf("k") !== -1;
    const isEnPassant = move.flags.indexOf("e") !== -1;
    const isPromotion = move.flags.indexOf("p") !== -1;
    if (isCapture) {
      this.squareCaptured(move.to);
    }
    if (isQueensideCastle) {
      const fromSquare = move.color === COLOR.B ? "a8" : "a1";
      const toSquare = move.color === COLOR.B ? "d8" : "d1";
      const rook = PositioningUtils.getPieceFromSquare(fromSquare);
      this.moveTo(rook, toSquare);
    }
    if (isKingsideCastle) {
      const fromSquare = move.color === COLOR.B ? "h8" : "h1";
      const toSquare = move.color === COLOR.B ? "f8" : "f1";
      const rook = PositioningUtils.getPieceFromSquare(fromSquare);
      this.moveTo(rook, toSquare);
    }
    if (isEnPassant) {
      const fromRank = move.from.substr(1, 1);
      const toFile = move.to.substr(0, 1);
      this.squareCaptured(`${toFile}${fromRank}`);
    }
    if (isPromotion) {
      const square = move.to;
      setTimeout(() => {
        this.squarePromoted(square);
      }, 750);
    }
  },

  squarePromoted(square) {
    const chessSet = document.querySelector("[chess-set]");
    const oldPiece = PositioningUtils.getPieceFromSquare(square);
    const color = oldPiece.metadata.color;
    const initialSquare = oldPiece.metadata.initialSquare;
    window.NAF.connection.broadcastData("removePiece", { id: oldPiece.id, color });
    this.el.sceneEl.emit("removePiece", { id: oldPiece.id, color });
    oldPiece.parentNode.removeChild(oldPiece);
    const newMeta = {
      type: "q",
      color,
      initialSquare,
      model: color === COLOR.W ? chessSet.queenW : chessSet.queenB,
      sendTo: square
    };
    const newPiece = document.createElement("a-entity");
    newPiece.setAttribute("chess-piece", newMeta);
    chessSet.appendChild(newPiece);
  },

  teleportPlayer(color) {
    this.sceneEl.systems["hubs-systems"].characterController.enableFly(true);
    if (color === COLOR.WHITE) {
      this.teleportWhite();
    } else if (color === COLOR.BLACK) {
      this.teleportBlack();
    }
  },

  teleportWhite() {
    const waypoint = this.el.sceneEl.systems["hubs-systems"].waypointSystem.ready.filter(w => w.el.className === "st-chess-waypoint-white")[0];
    if (waypoint) {
      this.el.sceneEl.systems["hubs-systems"].waypointSystem.moveToWaypoint(waypoint, true);
    } else {
      this.teleportWhiteDefault();
    }
  },

  teleportWhiteDefault() {
    const squareSize = this.chessGame.getAttribute("chess-game").squareSize;
    const destinationX = PositioningUtils.getPositionFromFile("e") - squareSize / 2;
    const destinationY = squareSize * 4;
    const destinationZ = PositioningUtils.getPositionFromRank("4") + squareSize * 5;
    this.doTeleport(destinationX, destinationY, destinationZ);
    const q = new THREE.Quaternion(-0.3046977306369239, 0.06475573883689406, 0.02076899796372855, 0.9500182292756172);
    this.sceneEl.querySelector("#avatar-pov-node").object3D.setRotationFromQuaternion(q);
  },

  teleportBlack() {
    const waypoint = this.el.sceneEl.systems["hubs-systems"].waypointSystem.ready.filter(w => w.el.className === "st-chess-waypoint-black")[0];
    if (waypoint) {
      this.el.sceneEl.systems["hubs-systems"].waypointSystem.moveToWaypoint(waypoint, true);
    } else {
      this.teleportBlackDefault();
    }
  },

  teleportBlackDefault() {
    const squareSize = this.chessGame.getAttribute("chess-game").squareSize;
    const destinationX = PositioningUtils.getPositionFromFile("e") - squareSize / 2;
    const destinationY = squareSize * 4;
    const destinationZ = PositioningUtils.getPositionFromRank("8") - squareSize * 4;
    this.doTeleport(destinationX, destinationY, destinationZ);
    const q = new THREE.Quaternion(-0.007975245041697407, 0.9725746384887974, 0.229994800204803, 0.033724767066099344);
    this.sceneEl.querySelector("#avatar-pov-node").object3D.setRotationFromQuaternion(q);
  },

  doTeleport(x, y, z) {
    const avatarRig = document.querySelector("#avatar-rig");
    avatarRig.removeAttribute("offset-relative-to");
    avatarRig.setAttribute("offset-relative-to", {
      target: this.chessGame,
      offset: { x, y, z }
    });
  },

  populateMoves(piece) {
    const lastSquare = PositioningUtils.getSquareFromPosition(piece.metadata.lastPosition).square;
    const moves = this.chessEngine.moves({ square: lastSquare, verbose: true }).map(m => m.to);
    piece.metadata.moves = moves;
  },

  snapPiece(piece) {
    const destinationSquare = PositioningUtils.getSquareFromPosition(piece.getAttribute("position"));
    const destinationX = PositioningUtils.getPositionFromFile(destinationSquare.file);
    const destinationZ = PositioningUtils.getPositionFromRank(destinationSquare.rank);
    if (destinationX !== null && destinationZ !== null) {
      const isMoved =
        destinationX !== piece.metadata.lastPosition.x ||
        piece.metadata.pieceY !== piece.metadata.lastPosition.y ||
        destinationZ !== piece.metadata.lastPosition.z;
      if (isMoved) {
        this.moveTo(piece, destinationSquare.square);
        this.sceneEl.emit("chess-cursor", { enabled: false, valid: false });
      }
    }
  },

  squareCaptured(square) {
    GameNetwork.sendData(this.state.opponentId, "chess::capture-piece", { square });
    const piece = PositioningUtils.getPieceFromSquare(square);
    this.sceneEl.emit("chess-piece-died", { piece });
  },

  destroyMyPieces() {
    const chessSets = document.querySelectorAll("a-entity[chess-set]");
    for (const set of chessSets) {
      for (const child of set.children) {
        window.NAF.utils.takeOwnership(child);
        set.removeChild(child);
      }
      window.NAF.utils.takeOwnership(set);
      set.parentNode.removeChild(set);
    }
  },

  registerBoardPosition(component) {
    this.boardPosition = component;
  },

  registerGame(entity) {
    this.chessGame = entity;
  }
});