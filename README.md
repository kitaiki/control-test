# Cesium React Starter

React, TypeScript, CesiumJS, Tailwind CSS를 Vite로 구성한 기본 프로젝트입니다.

## 시작하기

```bash
npm install
npm run dev
```

프로덕션 빌드는 다음 명령으로 확인할 수 있습니다.

```bash
npm run build
npm run preview
```

## 구성

- React + TypeScript + Vite
- CesiumJS와 필수 정적 자산 자동 복사
- Tailwind CSS v4 Vite 플러그인
- Cesium ion 토큰 없이 실행되는 OpenStreetMap + sample_10 3D Tiles 건물

## 건물 정보 패널

건물 또는 `건물 정보 보기` 버튼을 누르면 화면 오른쪽으로 건물 구도가 이동하며
왼쪽 정보 패널이 나타납니다. 모바일에서는 건물이 위쪽으로 이동하고 하단 패널이 열립니다.
닫기 버튼이나 Escape 키로 선택 전 카메라 위치와 방향으로 돌아갑니다.

`src/buildingMotion.ts`의 공통 requestAnimationFrame 타임라인이 카메라와 패널을
약 900ms 동안 함께 보간합니다. 연속 열기/닫기는 현재 진행 상태에서 이어지며,
OS의 동작 줄이기 설정을 따릅니다. 패널은 `public/sample_10/catalog.json`의 실제 메타데이터를 사용합니다.
건물의 지리 좌표는 tileset의 루트 transform을 그대로 유지합니다.

## 층별 모델과 호버 표시

전체 `preview/building.glb`를 먼저 렌더링하고, 16개 층 GLB가 모두 준비되면 한 번에 교체합니다.
층 준비가 실패하면 전체 미리보기 모델을 유지합니다. 마우스로 가리킨 GLB의 층명을 표시하며,
선택 층의 기둥·보 형태는 형광 연두색, 나머지 면은 낮은 불투명도로 표시합니다.
포인터가 벗어나거나 카메라가 이동하면 기본 스타일로 복원됩니다.

최적화된 GLB에는 부재별 IFC 분류가 대부분 남아 있지 않아 `structure.json`은 연결된 형상의
크기와 남아 있는 재질 이름을 이용한 **기둥·보 형태 추정**입니다. 정확한 IFC 부재 분류가
필요하면 원본 IFC의 부재 ID·타입을 보존한 모델이 필요합니다.
층 GLB를 교체할 때는 `node scripts/build-floor-structure.mjs`로 구조 마스크도 재생성하세요.
원본 GLB 파일은 변경하지 않습니다.

`npm test`로 모델 교체, 실패 시 미리보기 유지, 호버 복원 및 리소스 정리를 검증합니다 (Node.js 24 이상).

Cesium ion에서 제공하는 지형이나 3D Tiles를 사용할 때는 `.env.local`에 토큰을 추가하고
`import.meta.env.VITE_CESIUM_ION_TOKEN`으로 읽어 사용하세요.

```dotenv
VITE_CESIUM_ION_TOKEN=your_token_here
```
