import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, collection, query, where, getDocs,
  onSnapshot, serverTimestamp, runTransaction, waitForPendingWrites, enableNetwork
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

let user = null;
let membershipRecord = null;
let householdId = "";
let role = "member";
let stateRef = null;
let unsubscribeState = null;
let unsubscribeMembers = null;
let applyingCloud = false;
let cloudLoaded = false;
let cloudRevision = 0;
let saveTimer = null;
let queuedStateJson = "";
let saveInProgress = false;

function updateStatus(kind, text) {
  window.updateSyncStatus?.(kind, text);
}

function validSharedState(data) {
  if (!data || typeof data.valueJson !== "string") return false;
  try {
    const parsed = JSON.parse(data.valueJson);
    return parsed && Array.isArray(parsed.transactions) && Array.isArray(parsed.budgets);
  } catch {
    return false;
  }
}

async function findMembership(uid) {
  const result = await getDocs(query(collection(db, "householdMembers"), where("uid", "==", uid)));
  if (result.empty) return null;
  const active = result.docs.find(item => item.data().status === "active") || result.docs[0];
  return { id: active.id, ...active.data() };
}

function diagnostics() {
  return [
    `Project: ${firebaseConfig.projectId}`,
    `Household: ${householdId || "not loaded"}`,
    `Storage path: householdStates/${householdId || "..."}`,
    `Role: ${role}`,
    `Cloud revision: ${cloudRevision}`
  ].join("\n");
}

async function commitJson(json, options = {}) {
  const nextRevision = cloudRevision + 1;
  await setDoc(stateRef, {
    householdId,
    valueJson: json,
    revision: nextRevision,
    schemaVersion: 16,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    ...(options.initialize ? {
      initializedAt: serverTimestamp(),
      initializedBy: user.uid
    } : {})
  }, { merge: true });
  await waitForPendingWrites(db);
  cloudRevision = nextRevision;
  updateStatus("online", `● Synced r${cloudRevision}`);
}

async function flushQueuedState() {
  if (!cloudLoaded || applyingCloud || saveInProgress || !queuedStateJson) return;
  saveInProgress = true;
  const json = queuedStateJson;
  queuedStateJson = "";
  updateStatus("", "● Syncing");
  try {
    await commitJson(json);
  } catch (error) {
    queuedStateJson = json;
    console.error("Hestia Firestore save failed", error);
    updateStatus("error", "● Save failed");
    alert(`Hestia could not save to Firestore: ${error.message}`);
  } finally {
    saveInProgress = false;
    if (queuedStateJson) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flushQueuedState, 250);
    }
  }
}

function startStateListener() {
  unsubscribeState?.();
  unsubscribeState = onSnapshot(
    stateRef,
    { includeMetadataChanges: true },
    snapshot => {
      if (!snapshot.exists() || !validSharedState(snapshot.data())) return;
      const data = snapshot.data();
      cloudRevision = Number(data.revision || 0);
      try {
        applyingCloud = true;
        window.hestia.setState(JSON.parse(data.valueJson));
        cloudLoaded = true;
        window.hideCloudSetup?.();
        updateStatus(
          snapshot.metadata.hasPendingWrites ? "" : "online",
          snapshot.metadata.hasPendingWrites ? "● Syncing" : `● Synced r${cloudRevision}`
        );
      } catch (error) {
        console.error("Hestia cloud data could not be applied", error);
        updateStatus("error", "● Cloud data error");
      } finally {
        applyingCloud = false;
      }
    },
    error => {
      console.error("Hestia Firestore listener failed", error);
      updateStatus("error", "● Sync error");
    }
  );
}

window.hestiaInitializeCloud = async () => {
  if (role !== "owner") return alert("Only the household owner can initialize shared data.");
  if (!confirm("Upload all details currently shown on this device as the shared household data?")) return;
  updateStatus("", "● Initializing");
  try {
    await commitJson(JSON.stringify(window.hestia.getState()), { initialize: true });
    cloudLoaded = true;
    window.hideCloudSetup?.();
    startStateListener();
  } catch (error) {
    console.error("Hestia initialization failed", error);
    updateStatus("error", "● Init failed");
    alert(`Cloud initialization failed: ${error.message}`);
  }
};

window.hestiaReplaceCloud = async () => {
  if (role !== "owner") return alert("Only the household owner can replace shared data.");
  if (!confirm("Replace the shared Firestore data with everything currently shown on this device?")) return;
  updateStatus("", "● Syncing");
  try {
    await commitJson(JSON.stringify(window.hestia.getState()), { initialize: true });
    cloudLoaded = true;
    window.hideCloudSetup?.();
  } catch (error) {
    updateStatus("error", "● Save failed");
    alert(error.message);
  }
};

window.hestiaForceSync = async () => {
  if (!cloudLoaded) return window.hestiaCloudTools?.();
  queuedStateJson = JSON.stringify(window.hestia.getState());
  await flushQueuedState();
};

window.hestiaCloudTools = () => {
  window.showCloudSetup?.({
    title: "Cloud synchronization",
    message: role === "owner"
      ? "The current device can replace the shared Firestore state. Use this only when this device contains the correct household details."
      : "Shared data is managed by the household owner.",
    diagnostics: diagnostics(),
    owner: role === "owner",
    missing: !cloudLoaded
  });
};

async function loadHousehold(record) {
  membershipRecord = record;
  householdId = record.householdId;
  role = record.role || "member";

  if (record.status === "pending") {
    login.classList.add("hide");
    familySetup.classList.remove("hide");
    createFamily.classList.add("hide");
    joinFamily.parentElement.classList.add("hide");
    setupMsg.textContent = "Your request is awaiting approval.";
    return;
  }

  login.classList.add("hide");
  familySetup.classList.add("hide");
  window.hestia.setUser({
    displayName: record.displayName || user.displayName || user.email,
    email: user.email,
    role
  });

  unsubscribeMembers?.();
  unsubscribeMembers = onSnapshot(
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
    error => console.error("Member listener failed", error)
  );

  // A top-level document makes persistence easy to verify in Firestore Console.
  stateRef = doc(db, "householdStates", householdId);
  updateStatus("", "● Loading cloud");
  const stateSnapshot = await getDoc(stateRef);

  if (!stateSnapshot.exists() || !validSharedState(stateSnapshot.data())) {
    cloudLoaded = false;
    window.showCloudSetup?.({
      title: role === "owner" ? "Initialize shared household" : "Waiting for owner",
      message: role === "owner"
        ? "No valid shared state exists. Confirm this device contains the correct household details, then initialize Firestore."
        : "The household owner must initialize Firestore before this device can load shared data.",
      diagnostics: diagnostics(),
      owner: role === "owner",
      missing: true
    });
    updateStatus("error", role === "owner" ? "● Setup required" : "● Waiting for owner");
    return;
  }

  const data = stateSnapshot.data();
  cloudRevision = Number(data.revision || 0);
  applyingCloud = true;
  window.hestia.setState(JSON.parse(data.valueJson));
  applyingCloud = false;
  cloudLoaded = true;
  startStateListener();

  window.hestia.setCloudSave(value => {
    if (applyingCloud || !cloudLoaded) return;
    queuedStateJson = JSON.stringify(value);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushQueuedState, 300);
  });
}

googleBtn.onclick = () => signInWithPopup(auth, provider).catch(error => loginMsg.textContent = error.message);
logoutBtn.onclick = () => signOut(auth);

createFamily.onclick = async () => {
  const name = prompt("Household name:", "My household")?.trim();
  if (!name) return;
  const householdRef = doc(collection(db, "households"));
  createFamily.disabled = true;
  try {
    await runTransaction(db, async transaction => {
      transaction.set(householdRef, { name, ownerUid: user.uid, createdAt: serverTimestamp() });
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
    await loadHousehold({ householdId: householdRef.id, role: "owner", status: "active", displayName: user.displayName });
  } catch (error) {
    setupMsg.textContent = error.message;
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
      const target = invite.data().householdId;
      transaction.set(doc(db, "householdMembers", `${target}_${user.uid}`), {
        householdId: target,
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
    setupMsg.textContent = error.message;
  }
};

inviteBtn.onclick = async () => {
  if (!["owner", "admin"].includes(role)) return alert("Only an owner or admin can invite.");
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  await setDoc(doc(db, "householdInvites", code), {
    householdId, active: true, createdBy: user.uid, createdAt: serverTimestamp()
  });
  prompt("Share this invitation code:", code);
};

window.hestiaAddManualMember = async (name, manualRole) => {
  await setDoc(doc(collection(db, "householdMembers")), {
    householdId, uid: "", email: "", displayName: name, role: manualRole,
    status: "active", manual: true, createdBy: user.uid, joinedAt: serverTimestamp()
  });
};
window.hestiaApproveMember = id => setDoc(doc(db, "householdMembers", id), {
  status: "active", role: "member", approvedBy: user.uid, approvedAt: serverTimestamp()
}, { merge: true });
window.hestiaRemoveMember = async id => {
  const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js");
  await deleteDoc(doc(db, "householdMembers", id));
};

window.addEventListener("online", () => {
  updateStatus("", "● Reconnecting");
  enableNetwork(db).catch(console.error);
});
window.addEventListener("offline", () => updateStatus("error", "● Offline"));

onAuthStateChanged(auth, async currentUser => {
  user = currentUser;
  if (!currentUser) {
    unsubscribeState?.();
    unsubscribeMembers?.();
    cloudLoaded = false;
    login.classList.remove("hide");
    familySetup.classList.add("hide");
    return;
  }
  window.hestia.setUser({ displayName: currentUser.displayName || currentUser.email, email: currentUser.email, role: "member" });
  try {
    const found = await findMembership(currentUser.uid);
    if (found) await loadHousehold(found);
    else {
      login.classList.add("hide");
      familySetup.classList.remove("hide");
    }
  } catch (error) {
    console.error("Hestia startup failed", error);
    loginMsg.textContent = error.message;
  }
});
