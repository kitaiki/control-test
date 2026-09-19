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

Cesium ion에서 제공하는 지형이나 3D Tiles를 사용할 때는 `.env.local`에 토큰을 추가하고
`import.meta.env.VITE_CESIUM_ION_TOKEN`으로 읽어 사용하세요.

```dotenv
VITE_CESIUM_ION_TOKEN=your_token_here
```
