// --- Methods
import React, { useContext, useEffect, useMemo, useState } from "react";

// --- Datadog
import { datadogLogs } from "@datadog/browser-logs";

import { debounce } from "ts-debounce";
import { BroadcastChannel } from "broadcast-channel";

// --- Identity tools
import {
  CredentialResponseBody,
  PLATFORM_ID,
  PROVIDER_ID,
  Stamp,
  VerifiableCredential,
  VerifiableCredentialRecord,
} from "@gitcoin/passport-types";
import { fetchVerifiableCredential } from "@gitcoin/passport-identity/dist/commonjs/src/credentials";

// --- Style Components
import { SideBarContent } from "../SideBarContent";
import { DoneToastContent } from "../DoneToastContent";
import { useToast } from "@chakra-ui/react";

// --- Context
import { CeramicContext } from "../../context/ceramicContext";
import { UserContext } from "../../context/userContext";

// --- Platform definitions
import { getPlatformSpec } from "../../config/platforms";
import { STAMP_PROVIDERS } from "../../config/providers";

// --- Helpers
import { difference } from "../../utils/helpers";

// Each platform is recognised by its ID
const platformId: PLATFORM_ID = "Idena";

export default function IdenaPlatform(): JSX.Element {
  const { address, signer } = useContext(UserContext);
  const { handleAddStamps, allProvidersState, handleDeleteStamps } = useContext(CeramicContext);
  const [isLoading, setLoading] = useState(false);
  const [state, setState] = useState("");
  const [canSubmit, setCanSubmit] = useState(false);

  // find all providerIds
  const providerIds = useMemo(
    () =>
      STAMP_PROVIDERS[platformId]?.reduce((all, stamp) => {
        return all.concat(stamp.providers?.map((provider) => provider.name as PROVIDER_ID));
      }, [] as PROVIDER_ID[]) || [],
    []
  );

  // SelectedProviders will be passed in to the sidebar to be filled there...
  const [verifiedProviders, setVerifiedProviders] = useState<PROVIDER_ID[]>(
    providerIds.filter((providerId) => typeof allProvidersState[providerId]?.stamp?.credential !== "undefined")
  );
  // SelectedProviders will be passed in to the sidebar to be filled there...
  const [selectedProviders, setSelectedProviders] = useState<PROVIDER_ID[]>([...verifiedProviders]);

  // Create Set to check initial verified providers
  const initialVerifiedProviders = new Set(verifiedProviders);

  // any time we change selection state...
  useEffect(() => {
    if (selectedProviders.length !== verifiedProviders.length) {
      setCanSubmit(true);
    }
  }, [selectedProviders, verifiedProviders]);

  // --- Chakra functions
  const toast = useToast();

  // Fetch Idena SignIn token from the IAM procedure
  async function handleFetchIdenaSignIn(): Promise<void> {
    // Fetch data from external API
    const procedureUrl = process.env.NEXT_PUBLIC_PASSPORT_PROCEDURE_URL?.replace(/\/*?$/, "");
    const idenaCallback = process.env.NEXT_PUBLIC_PASSPORT_IDENA_CALLBACK?.replace(/\/*?$/, "");
    const idenaWebApp = process.env.NEXT_PUBLIC_PASSPORT_IDENA_WEB_APP?.replace(/\/*?$/, "");
    const res = await fetch(`${procedureUrl}/idena/create-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });
    const data = await res.json();
    const state = data.token;
    setState(state);
    const callbackUrl = encodeURIComponent(`${idenaCallback}?state=${state}`);
    const endpoint = procedureUrl;
    const nonceEndpoint = `${endpoint}/idena/start-session`;
    const authenticationEndpoint = `${endpoint}/idena/authenticate`;
    const signInUrl = `${idenaWebApp}/dna/signin?token=${data.token}&callback_url=${callbackUrl}&callback_target=self&nonce_endpoint=${nonceEndpoint}&authentication_endpoint=${authenticationEndpoint}`;
    // open new window for SignIn
    openIdenaSignInUrl(signInUrl);
  }

  // Open Idena SignIn in centered window
  function openIdenaSignInUrl(url: string): void {
    const width = 600;
    const height = 800;
    const left = screen.width / 2 - width / 2;
    const top = screen.height / 2 - height / 2;

    // Pass data to the page via props
    window.open(
      url,
      "_blank",
      "toolbar=no, location=no, directories=no, status=no, menubar=no, resizable=no, copyhistory=no, width=" +
        width +
        ", height=" +
        height +
        ", top=" +
        top +
        ", left=" +
        left
    );
  }

  // Listener to watch for SignIn redirect response on other windows (on the same host)
  function listenForRedirect(e: { target: string; data: { /*code: string;*/ state: string } }) {
    // when receiving Idena SignIn response from a spawned child run fetchVerifiableCredential
    if (e.target !== "idena") {
      return;
    }

    const queryState = e.data.state;
    if (state !== queryState) {
      datadogLogs.logger.error("State mismatch, failed to create Idena credential", { platform: platformId });
      return;
    }

    datadogLogs.logger.info("Saving Stamp", { platform: platformId });
    // fetch and store credential
    setLoading(true);

    // fetch VCs for only the selectedProviders
    fetchVerifiableCredential(
      process.env.NEXT_PUBLIC_PASSPORT_IAM_URL || "",
      {
        type: platformId,
        types: selectedProviders,
        version: "0.0.0",
        address: address || "",
        proofs: {
          token: queryState,
        },
      },
      signer as { signMessage: (message: string) => Promise<string> }
    )
      .then(async (verified: VerifiableCredentialRecord): Promise<void> => {
        // because we provided a types array in the params we expect to receive a credentials array in the response...
        const vcs =
          verified.credentials
            ?.map((cred: CredentialResponseBody): Stamp | undefined => {
              if (!cred.error) {
                // add each of the requested/received stamps to the passport...
                return {
                  provider: cred.record?.type as PROVIDER_ID,
                  credential: cred.credential as VerifiableCredential,
                };
              }
            })
            .filter((v: Stamp | undefined) => v) || [];
        // Update/remove stamps
        await handleDeleteStamps(providerIds as PROVIDER_ID[]);
        // Add all the stamps to the passport at once
        await handleAddStamps(vcs as Stamp[]);
        // report success to datadog
        datadogLogs.logger.info("Successfully saved Stamp", { platform: platformId });
        // grab all providers who are verified from the verify response
        const actualVerifiedProviders = providerIds.filter(
          (providerId) =>
            !!vcs.find((vc: Stamp | undefined) => vc?.credential?.credentialSubject?.provider === providerId)
        );
        // both verified and selected should look the same after save
        setVerifiedProviders([...actualVerifiedProviders]);
        setSelectedProviders([...actualVerifiedProviders]);

        // Create Set to check changed providers after verification
        const updatedVerifiedProviders = new Set(actualVerifiedProviders);

        // Initial providers set minus updated providers set to determine which data points were removed
        const initialMinusUpdated = difference(initialVerifiedProviders, updatedVerifiedProviders);
        // Updated providers set minus initial providers set to determine which data points were added
        const updatedMinusInitial = difference(updatedVerifiedProviders, initialVerifiedProviders);
        // reset can submit state
        setCanSubmit(false);

        // Custom Success Toast
        if (updatedMinusInitial.size > 0 && initialMinusUpdated.size === 0) {
          addedDataPointsToast(updatedMinusInitial, initialVerifiedProviders);
        } else if (initialMinusUpdated.size > 0 && updatedMinusInitial.size === 0 && selectedProviders.length === 0) {
          removedAllDataPointsToast();
        } else if (initialMinusUpdated.size > 0 && updatedMinusInitial.size === 0) {
          removedDataPointsToast(initialMinusUpdated);
        } else if (updatedMinusInitial.size > 0 && initialMinusUpdated.size > 0) {
          addedRemovedDataPointsToast(initialMinusUpdated, updatedMinusInitial);
        } else if (updatedMinusInitial.size === providerIds.length) {
          completeVerificationToast();
        } else {
          failedVerificationToast();
        }
      })
      .catch((e) => {
        datadogLogs.logger.error("Verification Error", { error: e, platform: platformId });
        throw e;
      })
      .finally(() => {
        setLoading(false);
      });
  }

  // --- Done Toast Helpers
  const addedDataPointsToast = (updatedMinusInitals: Set<PROVIDER_ID>, initalVPs: Set<PROVIDER_ID>) => {
    toast({
      duration: 5000,
      isClosable: true,
      render: (result: any) => (
        <DoneToastContent
          title="Success!"
          body={`${updatedMinusInitals.size + initalVPs.size} ${platformId} data points verified out of ${
            providerIds.length
          }.`}
          icon="../../assets/check-icon.svg"
          platformId={platformId}
          result={result}
        />
      ),
    });
  };

  const removedDataPointsToast = (initialVPs: Set<PROVIDER_ID>) => {
    toast({
      duration: 5000,
      isClosable: true,
      render: (result: any) => (
        <DoneToastContent
          title="Success!"
          body={`${initialVPs.size} ${platformId} data ${initialVPs.size > 1 ? "points" : "point"} removed.`}
          icon="../../assets/check-icon.svg"
          platformId={platformId}
          result={result}
        />
      ),
    });
  };

  const removedAllDataPointsToast = () => {
    toast({
      duration: 5000,
      isClosable: true,
      render: (result: any) => (
        <DoneToastContent
          title="Success!"
          body={`All ${platformId} data points removed.`}
          icon="../../assets/check-icon.svg"
          platformId={platformId}
          result={result}
        />
      ),
    });
  };

  const addedRemovedDataPointsToast = (initialVPs: Set<PROVIDER_ID>, updatedVPs: Set<PROVIDER_ID>) => {
    toast({
      duration: 5000,
      isClosable: true,
      render: (result: any) => (
        <DoneToastContent
          title="Success!"
          body={`${initialVPs.size} ${platformId} data ${initialVPs.size > 1 ? "points" : "point"} removed and ${
            updatedVPs.size
          } verified.`}
          icon="../../assets/check-icon.svg"
          platformId={platformId}
          result={result}
        />
      ),
    });
  };

  const completeVerificationToast = () => {
    toast({
      duration: 5000,
      isClosable: true,
      render: (result: any) => (
        <DoneToastContent
          title="Done!"
          body={`All ${platformId} data points verified.`}
          icon="../../assets/check-icon.svg"
          platformId={platformId}
          result={result}
        />
      ),
    });
  };

  const failedVerificationToast = () => {
    toast({
      duration: 5000,
      isClosable: true,
      render: (result: any) => (
        <DoneToastContent
          title="Verification Failed"
          body="Please make sure you fulfill the requirements for this stamp."
          icon="../../assets/verification-failed.svg"
          platformId={platformId}
          result={result}
        />
      ),
    });
  };

  // attach and destroy a BroadcastChannel to handle the message
  useEffect(() => {
    // open the channel
    const channel = new BroadcastChannel("idena_sign_in_channel");
    // event handler will listen for messages from the child (debounced to avoid multiple submissions)
    channel.onmessage = debounce(listenForRedirect, 300);

    return () => {
      channel.close();
    };
  });

  return (
    <SideBarContent
      currentPlatform={getPlatformSpec("Idena")}
      currentProviders={STAMP_PROVIDERS["Idena"]}
      verifiedProviders={verifiedProviders}
      selectedProviders={selectedProviders}
      setSelectedProviders={setSelectedProviders}
      isLoading={isLoading}
      verifyButton={
        <button
          disabled={!canSubmit}
          onClick={handleFetchIdenaSignIn}
          data-testid="button-verify-idena"
          className="sidebar-verify-btn"
        >
          {verifiedProviders.length > 0 ? <p>Save</p> : <p>Verify</p>}
        </button>
      }
    />
  );
}