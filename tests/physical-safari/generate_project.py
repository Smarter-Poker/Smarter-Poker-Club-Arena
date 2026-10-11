"""Root build-only deterministic Xcode project generator; no credentials/network."""
from pathlib import Path
import os
R=Path(__file__).resolve().parent;O=R/'ios'/'Acceptance.xcodeproj';O.mkdir()
# Minimal ordinary app plus hosted UI-test runner, Safari launched explicitly by XCTest.
s="""// !$*UTF8*$!
{archiveVersion=1;classes={};objectVersion=56;objects={
A={isa=PBXProject;buildConfigurationList=B;compatibilityVersion="Xcode 14.0";mainGroup=C;productRefGroup=D;targets=(E,F);};
B={isa=XCConfigurationList;buildConfigurations=(G);defaultConfigurationName=Debug;};G={isa=XCBuildConfiguration;name=Debug;buildSettings={SDKROOT=iphoneos;IPHONEOS_DEPLOYMENT_TARGET=15.0;SWIFT_VERSION=5.0;CODE_SIGNING_ALLOWED=NO;};};
C={isa=PBXGroup;children=(H,I,D);sourceTree="<group>";};D={isa=PBXGroup;name=Products;children=(J,K);sourceTree="<group>";};
H={isa=PBXFileReference;path=Host.swift;sourceTree="<group>";lastKnownFileType=sourcecode.swift;};I={isa=PBXFileReference;path=SafariTests.swift;sourceTree="<group>";lastKnownFileType=sourcecode.swift;};
J={isa=PBXFileReference;path=AcceptanceHost.app;sourceTree=BUILT_PRODUCTS_DIR;explicitFileType=wrapper.application;};K={isa=PBXFileReference;path=SafariTests.xctest;sourceTree=BUILT_PRODUCTS_DIR;explicitFileType=wrapper.cfbundle;};
E={isa=PBXNativeTarget;name=AcceptanceHost;productName=AcceptanceHost;productReference=J;productType="com.apple.product-type.application";buildConfigurationList=L;buildPhases=(M);dependencies=();};
F={isa=PBXNativeTarget;name=SafariTests;productName=SafariTests;productReference=K;productType="com.apple.product-type.bundle.ui-testing";buildConfigurationList=N;buildPhases=(P);dependencies=(Q);};
Q={isa=PBXTargetDependency;target=E;};
L={isa=XCConfigurationList;buildConfigurations=(U);defaultConfigurationName=Debug;};U={isa=XCBuildConfiguration;name=Debug;buildSettings={PRODUCT_BUNDLE_IDENTIFIER=poker.smarter.acceptance.host;PRODUCT_NAME="$(TARGET_NAME)";GENERATE_INFOPLIST_FILE=YES;TARGETED_DEVICE_FAMILY=1;INFOPLIST_KEY_UIApplicationSceneManifest_Generation=NO;};};
N={isa=XCConfigurationList;buildConfigurations=(V);defaultConfigurationName=Debug;};V={isa=XCBuildConfiguration;name=Debug;buildSettings={PRODUCT_BUNDLE_IDENTIFIER=poker.smarter.acceptance.safaritests;PRODUCT_NAME="$(TARGET_NAME)";GENERATE_INFOPLIST_FILE=YES;TEST_TARGET_NAME=AcceptanceHost;TARGETED_DEVICE_FAMILY=1;};};
M={isa=PBXSourcesBuildPhase;files=(W);};P={isa=PBXSourcesBuildPhase;files=(X);};W={isa=PBXBuildFile;fileRef=H;};X={isa=PBXBuildFile;fileRef=I;};
};rootObject=A;}
"""
# Xcode IDs are fixed 24-hex identifiers, not arbitrary single-letter IDs.
import re
ids={k:f'{i:024X}'for i,k in enumerate('ABCDEFGH IJKLMN PQUVW X'.replace(' ',''),1)}
s=re.sub(r'\b([A-Z])\b',lambda m:ids.get(m[1],m[1]),s)
(O/'project.pbxproj').write_text(s)
scheme=O/'xcshareddata'/'xcschemes';scheme.mkdir(parents=True)
(scheme/'Acceptance.xcscheme').write_text(f"""<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="1600" version="1.3"><BuildAction parallelizeBuildables="NO" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ids['E']}" BuildableName="AcceptanceHost.app" BlueprintName="AcceptanceHost" ReferencedContainer="container:Acceptance.xcodeproj"/></BuildActionEntry><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ids['F']}" BuildableName="SafariTests.xctest" BlueprintName="SafariTests" ReferencedContainer="container:Acceptance.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ids['F']}" BuildableName="SafariTests.xctest" BlueprintName="SafariTests" ReferencedContainer="container:Acceptance.xcodeproj"/></TestableReference></Testables></TestAction></Scheme>""")
