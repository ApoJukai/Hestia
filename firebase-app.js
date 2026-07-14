import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  collection,
  query,
  where,
  getDocs,
  onSnapshot,
  serverTimestamp,
  runTransaction,
  waitForPendingWrites,
  enableNetwork
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

let user = null;
let householdId = "";
let role = "member";
let unsubState = null;
let unsubMembers = null;
let saveTimer = null;
let applyingRemote = false;
let cloudReady = false;
let lastRemoteJson = "";
let pendingJson = "";
let writing = false;

const setupMessage = text => {
  const element = document.getElementById("setupMsg");
  if (element) element.textContent = text;
};

const setSyncStatus = (status, text) => {
  if (typeof window.updateSyncStatus === "function") {
    window.updateSyncStatus(status, text);
  }
};

async function findMembership(uid) {
  const snapshot = await getDocs(
    query(collection(db, "householdMembers"), where("uid", "==", uid))
  );
  if (snapshot.empty) return null;
  const active = snapshot.docs.find(item => item.data().status === "active") || snapshot.docs[0];
  return { id: active.id, ...active.data() };
}

async function writeSharedState(ref, json) {
  await setDoc(ref, {
    valueJson: json,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    schemaVersion: 14
  }, { merge: true });
  await waitForPendingWrites(db);
}

async function flushCloudState(ref) {
  if (!cloudReady || applyingRemote || writing || !pendingJson) return;
  writing = true;
  const json = pendingJson;
  pendingJson = "";
  setSyncStatus("", "● Syncing");
  try {
    await writeSharedState(ref, json);
    lastRemoteJson = json;
    setSyncStatus("online", "● Synced");
  } catch (error) {
    pendingJson = json;
    console.error("Hestia cloud save failed", error);
    setSyncStatus("error", "● Save failed");
    alert("Hestia could not save to Firestore: " + error.message);
  } finally {
    writing = false;
    if (pendingJson && pendingJson !== json) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => flushCloudState(ref), 250);
    }
  }
}

async function loadHousehold(member) {
  householdId = member.householdId;
  role = member.role || "member";

  if (member.status === "pending") {
    login.classList.add("hide");
    familySetup.classList.remove("hide");
    createFamily.classList.add("hide");
    joinFamily.parentElement.classList.add("hide");
    setupMessage("Your request is awaiting approval from a household owner or admin.");
    onSnapshot(doc(db, "householdMembers", member.id), snapshot => {
      if (snapshot.exists() && snapshot.data().status === "active") location.reload();
    });
    return;
  }

  login.classList.add("hide");
  familySetup.classList.add("hide");
  window.hestia.setUser({
    displayName: member.displayName || user.displayName || user.email,
    email: user.email,
    role
  });

  if (unsubMembers) unsubMembers();
  unsubMembers = onSnapshot(
    query(collection(db, "householdMembers"), where("householdId", "==", householdId)),
    snapshot => {
      const members = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      window.hestia.setMembers(members);
      const me = members.find(item => item.uid === user.uid);
      if (me) {
        role = me.role || role;
        window.hestia.setUser({
          displayName: me.displayName || user.displayName || user.email,
          email: user.email,
          role
        });
      }
    },
    error => console.error("Hestia member listener failed", error)
  );

  const stateRef = doc(db, "households", householdId, "app", "state");
  cloudReady = false;
  setSyncStatus("", "● Initializing");

  try {
    await runTransaction(db, async transaction => {
      const current = await transaction.get(stateRef);
      if (!current.exists()) {
        transaction.set(stateRef, {
          valueJson: JSON.stringify(window.hestia.getState()),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          updatedBy: user.uid,
          schemaVersion: 14
        });
      }
    });
  } catch (error) {
    console.error("Hestia state initialization failed", error);
    setSyncStatus("error", "● Init failed");
    alert("Hestia could not initialize Firestore state: " + error.message);
    return;
  }

  if (unsubState) unsubState();
  unsubState = onSnapshot(
    stateRef,
    { includeMetadataChanges: true },
    snapshot => {
      if (!snapshot.exists()) return;
      const data = snapshot.data();
      const json = data.valueJson || "{}";
      try {
        if (json !== lastRemoteJson) {
          applyingRemote = true;
          window.hestia.setState(JSON.parse(json));
          lastRemoteJson = json;
        }
        cloudReady = true;
        setSyncStatus(
          snapshot.metadata.hasPendingWrites ? "" : "online",
          snapshot.metadata.hasPendingWrites ? "● Syncing" : "● Synced"
        );
      } catch (error) {
        console.error("Hestia shared state is invalid", error);
        setSyncStatus("error", "● Invalid cloud data");
      } finally {
        applyingRemote = false;
      }
    },
    error => {
      console.error("Hestia state listener failed", error);
      setSyncStatus("error", "● Sync error");
    }
  );

  window.hestia.setCloudSave(value => {
    if (applyingRemote || !cloudReady) return;
    pendingJson = JSON.stringify(value);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushCloudState(stateRef), 300);
  });

  window.hestiaForceSync = async () => {
    pendingJson = JSON.stringify(window.hestia.getState());
    await flushCloudState(stateRef);
  };
}

googleBtn.onclick = () => signInWithPopup(auth, provider)
  .catch(error => loginMsg.textContent = error.message);
logoutBtn.onclick = () => signOut(auth);

createFamily.onclick = async () => {
  const name = prompt("Household name:", "My household")?.trim();
  if (!name) return;
  createFamily.disabled = true;
  setupMessage("Creating household...");
  const householdRef = doc(collection(db, "households"));
  try {
    await runTransaction(db, async transaction => {
      transaction.set(householdRef, {
        name,
        ownerUid: user.uid,
        createdAt: serverTimestamp()
      });
      transaction.set(doc(db, "householdMembers", `${householdRef.id}_${user.uid}`), {
        householdId: householdRef.id,
        uid: user.uid,
        email: user.email || "",
        displayName: user.displayName || user.email,
        role: "owner",
        status: "active",
        joinedAt: serverTimestamp()
      });
    });
    await loadHousehold({
      householdId: householdRef.id,
      role: "owner",
      status: "active",
      displayName: user.displayName
    });
  } catch (error) {
    setupMessage("Could not create household: " + error.message);
  } finally {
    createFamily.disabled = false;
  }
};

joinFamily.onclick = async () => {
  const code = inviteCode.value.trim().toUpperCase();
  try {
    await runTransaction(db, async transaction => {
      const inviteRef = doc(db, "householdInvites", code);
      const invite = await transaction.get(inviteRef);
      if (!invite.exists() || !invite.data().active) throw Error("Invalid invitation code");
      const targetHousehold = invite.data().householdId;
      transaction.set(doc(db, "householdMembers", `${targetHousehold}_${user.uid}`), {
        householdId: targetHousehold,
        uid: user.uid,
        email: user.email || "",
        displayName: user.displayName || user.email,
        role: "member",
        status: "pending",
        joinedAt: serverTimestamp()
      });
      transaction.update(inviteRef, { active: false, usedBy: user.uid, usedAt: serverTimestamp() });
    });
    await loadHousehold(await findMembership(user.uid));
  } catch (error) {
    setupMessage(error.message);
  }
};

inviteBtn.onclick = async () => {
  if (!["owner", "admin"].includes(role)) return alert("Only an owner or admin can invite.");
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  await setDoc(doc(db, "householdInvites", code), {
    householdId,
    active: true,
    createdBy: user.uid,
    createdAt: serverTimestamp()
  });
  prompt("Share this invitation code:", code);
};

window.hestiaAddManualMember = async (name, manualRole) => {
  if (!["owner", "admin"].includes(role)) return alert("Only an owner or admin can add household members.");
  const memberRef = doc(collection(db, "householdMembers"));
  await setDoc(memberRef, {
    householdId,
    uid: "",
    email: "",
    displayName: name,
    role: manualRole,
    status: "active",
    manual: true,
    createdBy: user.uid,
    joinedAt: serverTimestamp()
  });
};

window.hestiaApproveMember = async id => {
  if (!["owner", "admin"].includes(role)) return alert("Only an owner or admin can approve members.");
  await setDoc(doc(db, "householdMembers", id), {
    status: "active",
    role: "member",
    approvedBy: user.uid,
    approvedAt: serverTimestamp()
  }, { merge: true });
};

window.hestiaRemoveMember = async id => {
  if (!["owner", "admin"].includes(role)) return alert("Only an owner or admin can remove members.");
  const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js");
  await deleteDoc(doc(db, "householdMembers", id));
};

window.addEventListener("online", () => {
  setSyncStatus("", "● Reconnecting");
  enableNetwork(db).catch(console.error);
});
window.addEventListener("offline", () => setSyncStatus("error", "● Offline"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && typeof window.hestiaForceSync === "function") {
    window.hestiaForceSync();
  }
});

onAuthStateChanged(auth, async currentUser => {
  user = currentUser;
  if (!currentUser) {
    if (unsubState) unsubState();
    if (unsubMembers) unsubMembers();
    cloudReady = false;
    login.classList.remove("hide");
    familySetup.classList.add("hide");
    setSyncStatus("", "● Signed out");
    return;
  }

  window.hestia.setUser({
    displayName: currentUser.displayName || currentUser.email,
    email: currentUser.email,
    role: "member"
  });

  try {
    const member = await findMembership(currentUser.uid);
    if (member) {
      await loadHousehold(member);
    } else {
      login.classList.add("hide");
      familySetup.classList.remove("hide");
    }
  } catch (error) {
    console.error("Hestia login setup failed", error);
    loginMsg.textContent = error.message;
  }
});
