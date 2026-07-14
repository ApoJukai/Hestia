import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, collection, query, where, getDocs, getDoc,
  onSnapshot, serverTimestamp, runTransaction, waitForPendingWrites, enableNetwork
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
let cloudLoaded = false;
let pendingJson = "";
let saving = false;
let stateRef = null;

const setupMessage = text => {
  const node = document.getElementById("setupMsg");
  if (node) node.textContent = text;
};

async function findActiveMembership(uid) {
  const result = await getDocs(query(collection(db, "householdMembers"), where("uid", "==", uid)));
  if (result.empty) return null;
  const records = result.docs.map(item => ({ id: item.id, ...item.data() }));
  return records.find(item => item.status === "active") || records.find(item => item.status === "pending") || records[0];
}

async function savePendingState() {
  if (!cloudLoaded || applyingRemote || saving || !pendingJson || !stateRef) return;
  saving = true;
  const json = pendingJson;
  pendingJson = "";
  try {
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(stateRef);
      const revision = Number(snapshot.data()?.revision || 0) + 1;
      transaction.set(stateRef, {
        householdId,
        valueJson: json,
        revision,
        schemaVersion: 17,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid
      }, { merge: true });
    });
    await waitForPendingWrites(db);
  } catch (error) {
    pendingJson = json;
    console.error("Hestia Firestore save failed", error);
    alert("Hestia could not save to Firestore: " + error.message);
  } finally {
    saving = false;
    if (pendingJson) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(savePendingState, 350);
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

  unsubMembers?.();
  unsubMembers = onSnapshot(
    query(collection(db, "householdMembers"), where("householdId", "==", householdId)),
    snapshot => {
      const members = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      window.hestia.setMembers(members);
      const currentMembership = members.find(item => item.uid === user.uid && item.status === "active");
      if (currentMembership) {
        role = currentMembership.role || role;
        window.hestia.setUser({
          displayName: currentMembership.displayName || user.displayName || user.email,
          email: user.email,
          role
        });
      }
    },
    error => console.error("Hestia member listener failed", error)
  );

  // All devices use exactly this one document.
  stateRef = doc(db, "householdStates", householdId);
  cloudLoaded = false;
  const initial = await getDoc(stateRef);

  if (!initial.exists() || typeof initial.data().valueJson !== "string") {
    if (role !== "owner") {
      alert("Shared household data has not been initialized by the owner yet.");
      return;
    }
    if (!confirm("No shared Firestore state exists. Initialize it from the data currently shown on this owner device?")) return;
    await setDoc(stateRef, {
      householdId,
      valueJson: JSON.stringify(window.hestia.getState()),
      revision: 1,
      schemaVersion: 17,
      initializedAt: serverTimestamp(),
      initializedBy: user.uid,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid
    });
    await waitForPendingWrites(db);
  } else {
    // Cloud always wins during startup, preventing PC defaults from replacing phone data.
    applyingRemote = true;
    try {
      window.hestia.setState(JSON.parse(initial.data().valueJson));
    } finally {
      applyingRemote = false;
    }
  }

  cloudLoaded = true;
  unsubState?.();
  unsubState = onSnapshot(
    stateRef,
    { includeMetadataChanges: true },
    snapshot => {
      if (!snapshot.exists() || typeof snapshot.data().valueJson !== "string") return;
      if (snapshot.metadata.hasPendingWrites) return;
      try {
        applyingRemote = true;
        window.hestia.setState(JSON.parse(snapshot.data().valueJson));
      } catch (error) {
        console.error("Hestia Firestore state is invalid", error);
      } finally {
        applyingRemote = false;
      }
    },
    error => {
      console.error("Hestia Firestore listener failed", error);
      alert("Hestia lost its Firestore connection: " + error.message);
    }
  );

  window.hestia.setCloudSave(value => {
    if (applyingRemote || !cloudLoaded) return;
    pendingJson = JSON.stringify(value);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePendingState, 350);
  });

  window.hestiaForceSync = async () => {
    pendingJson = JSON.stringify(window.hestia.getState());
    await savePendingState();
  };
}

googleBtn.onclick = () => signInWithPopup(auth, provider).catch(error => loginMsg.textContent = error.message);
logoutBtn.onclick = () => signOut(auth);

createFamily.onclick = async () => {
  const name = prompt("Household name:", "My household")?.trim();
  if (!name) return;
  createFamily.disabled = true;
  setupMessage("Creating household...");
  const householdRef = doc(collection(db, "households"));
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
      transaction.set(doc(db, "householdStates", householdRef.id), {
        householdId: householdRef.id,
        valueJson: JSON.stringify(window.hestia.getState()),
        revision: 1,
        schemaVersion: 17,
        initializedAt: serverTimestamp(),
        initializedBy: user.uid,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid
      });
    });
    await loadHousehold({ householdId: householdRef.id, uid: user.uid, role: "owner", status: "active", displayName: user.displayName });
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
    await loadHousehold(await findActiveMembership(user.uid));
  } catch (error) {
    setupMessage(error.message);
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

window.addEventListener("online", () => enableNetwork(db).catch(console.error));
onAuthStateChanged(auth, async currentUser => {
  user = currentUser;
  if (!currentUser) {
    unsubState?.();
    unsubMembers?.();
    cloudLoaded = false;
    login.classList.remove("hide");
    familySetup.classList.add("hide");
    return;
  }
  window.hestia.setUser({ displayName: currentUser.displayName || currentUser.email, email: currentUser.email, role: "member" });
  try {
    const member = await findActiveMembership(currentUser.uid);
    if (member) await loadHousehold(member);
    else {
      login.classList.add("hide");
      familySetup.classList.remove("hide");
    }
  } catch (error) {
    console.error("Hestia startup failed", error);
    loginMsg.textContent = error.message;
  }
});
